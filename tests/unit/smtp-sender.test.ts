import { afterEach, describe, expect, it, vi } from 'vitest';
import { protocolDebugLogger } from '../../src/boundary.js';
import {
  SMTP_CONNECTION_TIMEOUT_MS,
  SMTP_SOCKET_TIMEOUT_MS,
  smtpTransportOptions,
  tlsSmtpSender,
} from '../../src/smtp/sender.js';
import { MailError } from '../../src/errors.js';
import type { Account } from '../../src/config/types.js';

function acc(port: number): Account {
  return {
    id: 'a',
    owner: 'alex',
    address: 'a@example.org',
    username: 'a@example.org',
    provider: 'imap',
    level: 'send',
    signature: undefined,
    imap: { host: 'mail.example.org', port: 993 },
    smtp: { host: 'smtp.example.org', port },
    mailboxes: {},
  };
}

describe('smtpTransportOptions', () => {
  it('uses implicit TLS on 465', () => {
    expect(smtpTransportOptions(acc(465), 'pw', false)).toMatchObject({
      secure: true,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      auth: { user: 'a@example.org', pass: 'pw' },
    });
  });

  it('requires STARTTLS on any other port', () => {
    expect(smtpTransportOptions(acc(587), 'pw', false)).toMatchObject({
      secure: false,
      requireTLS: true,
    });
  });

  it('never reads files or URLs and logs nothing unless debugging', () => {
    expect(smtpTransportOptions(acc(465), 'pw', false)).toMatchObject({
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
    });
  });

  it('bounds connection, greeting and socket waits', () => {
    expect(smtpTransportOptions(acc(465), 'pw', false)).toMatchObject({
      connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    });
  });

  it('passes protocol traffic to a logger when debugging', () => {
    const options = smtpTransportOptions(acc(465), 'pw', true);
    expect(options.debug).toBe(true);
    expect(options.logger).not.toBe(false);
  });
});

describe('tlsSmtpSender', () => {
  it('reports a failure without the server text, which may hold addresses', async () => {
    // Port 1 on localhost is closed: the connection fails before any server text exists.
    const account: Account = { ...acc(465), smtp: { host: '127.0.0.1', port: 1 } };
    const send = tlsSmtpSender(() => 'pw', false);
    let err: Error | undefined;
    try {
      await send(account, Buffer.from('x'), { from: 'a@example.org', to: ['b@example.org'] });
    } catch (e) {
      if (e instanceof Error) err = e;
    }
    expect(err).toBeInstanceOf(MailError);
    expect(err).toMatchObject({ code: 'send_failed' });
    const message = err?.message ?? '';
    expect(message).toContain('127.0.0.1');
    expect(message).toContain('account a');
    expect(message).not.toContain('b@example.org');
    expect(err?.cause).toBeInstanceOf(Error);
  });
});

describe('protocolDebugLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes one JSON line per entry to stderr', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    protocolDebugLogger('smtp', 'a').info({ tnx: 'x' }, 'hello %s', 'world');
    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toMatchObject({
      debug: 'smtp',
      account: 'a',
      entry: [{ tnx: 'x' }, 'hello %s', 'world'],
    });
  });

  it('never throws on bigint, Buffer or circular values', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const circular: { self?: object } = {};
    circular.self = circular;
    const log = protocolDebugLogger('imap', 'a');
    expect(() => {
      log.debug({ uid: 5n, data: Buffer.from('abc'), circular });
    }).not.toThrow();
    const line = String(write.mock.calls[0]?.[0]);
    expect(line).toContain('"5"');
    expect(line).toContain('<3 bytes>');
  });
});
