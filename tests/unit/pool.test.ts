import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImapPool } from '../../src/imap/pool.js';
import type { ImapClient } from '../../src/imap/client.js';
import type { Account } from '../../src/config/types.js';
import { MailError } from '../../src/errors.js';
import type { ConnectionErrorRecord } from '../../src/log.js';

const ACCOUNT = { id: 'a', imap: { host: 'h', port: 993 } } as Account;

interface FakeClient {
  client: ImapClient;
  logouts: number;
  emitClose: () => void;
  emitError: (err?: Error) => void;
  setUsable: (usable: boolean) => void;
}

function fakeClient(): FakeClient {
  const listeners: { close?: () => void; error?: (err: Error) => void } = {};
  let usable = true;
  const state = { logouts: 0 };
  const client = {
    get usable() {
      return usable;
    },
    mailbox: false,
    on(event: 'close' | 'error', listener: (err: Error) => void) {
      if (event === 'close') {
        listeners.close = () => {
          listener(new Error('closed'));
        };
      } else listeners.error = listener;
    },
    logout: () => {
      state.logouts += 1;
      return Promise.resolve();
    },
  } as Partial<ImapClient> as ImapClient;
  return {
    client,
    get logouts() {
      return state.logouts;
    },
    emitClose: () => listeners.close?.(),
    emitError: (err = new Error('boom')) => listeners.error?.(err),
    setUsable: (value) => {
      usable = value;
    },
  };
}

/** A connect function that hands out the given fakes in order. */
function sequence(fakes: FakeClient[]) {
  let i = 0;
  return vi.fn(() => {
    const next = fakes[i++];
    if (next === undefined) throw new Error('no more fake clients');
    return Promise.resolve(next.client);
  });
}

describe('ImapPool', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reuses one connection per account', async () => {
    const fake = fakeClient();
    const connect = vi.fn(() => Promise.resolve(fake.client));
    const pool = new ImapPool(connect, 60_000);
    await pool.use(ACCOUNT, () => Promise.resolve(1));
    await pool.use(ACCOUNT, () => Promise.resolve(2));
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('logs out after the idle time and reconnects on next use', async () => {
    const fakes = [fakeClient(), fakeClient()];
    const connect = sequence(fakes);
    const pool = new ImapPool(connect, 60_000);
    await pool.use(ACCOUNT, () => Promise.resolve());
    await vi.advanceTimersByTimeAsync(60_001);
    expect(fakes[0]?.logouts).toBe(1);
    await pool.use(ACCOUNT, () => Promise.resolve());
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does not close while a call is still running', async () => {
    const fake = fakeClient();
    const pool = new ImapPool(() => Promise.resolve(fake.client), 1_000);
    let finish: () => void = () => undefined;
    const running = pool.use(ACCOUNT, () => new Promise<void>((resolve) => (finish = resolve)));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.logouts).toBe(0);
    finish();
    await running;
  });

  it('reconnects after the server closed the connection', async () => {
    const fakes = [fakeClient(), fakeClient()];
    const connect = sequence(fakes);
    const pool = new ImapPool(connect, 60_000);
    await pool.use(ACCOUNT, () => Promise.resolve());
    fakes[0]?.emitClose();
    await pool.use(ACCOUNT, () => Promise.resolve());
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('survives an error event and reconnects on next use', async () => {
    const fakes = [fakeClient(), fakeClient()];
    const connect = sequence(fakes);
    const pool = new ImapPool(connect, 60_000, () => undefined);
    await pool.use(ACCOUNT, () => Promise.resolve());
    expect(() => fakes[0]?.emitError()).not.toThrow();
    await pool.use(ACCOUNT, () => Promise.resolve());
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('logs the class of a connection error once, without its message', async () => {
    const fake = fakeClient();
    const records: ConnectionErrorRecord[] = [];
    const pool = new ImapPool(
      () => Promise.resolve(fake.client),
      60_000,
      (r) => records.push(r),
    );
    await pool.use(ACCOUNT, () => Promise.resolve());
    const failure = Object.assign(new Error('secret server text'), { code: 'ECONNRESET' });
    fake.emitError(failure);
    fake.emitError(failure);
    expect(records).toEqual([
      {
        event: 'connection_error',
        account: 'a',
        error: {
          name: 'Error',
          code: 'ECONNRESET',
          responseStatus: null,
          serverResponseCode: null,
        },
      },
    ]);
  });

  it('reconnects when the client became unusable during a call', async () => {
    const fakes = [fakeClient(), fakeClient()];
    const connect = sequence(fakes);
    const pool = new ImapPool(connect, 60_000);
    await expect(
      pool.use(ACCOUNT, () => {
        fakes[0]?.setUsable(false);
        return Promise.reject(new Error('socket hang up'));
      }),
    ).rejects.toThrow('socket hang up');
    await pool.use(ACCOUNT, () => Promise.resolve());
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('wraps a failed login in connection_failed and retries next time', async () => {
    const fake = fakeClient();
    const connect = vi
      .fn<() => Promise<ImapClient>>()
      .mockRejectedValueOnce(new Error('AUTHENTICATIONFAILED'))
      .mockResolvedValue(fake.client);
    const pool = new ImapPool(connect, 60_000);
    const failure = pool.use(ACCOUNT, () => Promise.resolve());
    await expect(failure).rejects.toBeInstanceOf(MailError);
    await expect(failure).rejects.toMatchObject({ code: 'connection_failed' });
    await pool.use(ACCOUNT, () => Promise.resolve());
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('closeAll logs out every open connection', async () => {
    const fake = fakeClient();
    const pool = new ImapPool(() => Promise.resolve(fake.client), 60_000);
    await pool.use(ACCOUNT, () => Promise.resolve());
    await pool.closeAll();
    expect(fake.logouts).toBe(1);
  });
});
