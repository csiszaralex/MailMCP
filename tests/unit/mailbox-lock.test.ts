import { describe, expect, it } from 'vitest';
import type { MailboxLockOptions, MailboxObject } from 'imapflow';
import type { ImapClient } from '../../src/imap/client.js';
import { requireCapability, withMailbox } from '../../src/imap/mailbox-lock.js';
import { MailError } from '../../src/errors.js';

function fakeClient(capabilities: string[] = [], missing = false) {
  const locks: { path: string; options: MailboxLockOptions | undefined }[] = [];
  let released = 0;
  const client = {
    capabilities: new Map<string, boolean | number>(capabilities.map((c) => [c, true])),
    get mailbox(): MailboxObject {
      return { uidValidity: 7n } as MailboxObject;
    },
    getMailboxLock: (path: string, options?: MailboxLockOptions) => {
      locks.push({ path, options });
      if (missing) {
        return Promise.reject(
          Object.assign(new Error('no such mailbox'), { mailboxMissing: true }),
        );
      }
      return Promise.resolve({
        path,
        release: () => {
          released += 1;
        },
      });
    },
  } as Partial<ImapClient> as ImapClient;
  return {
    client,
    locks,
    get released() {
      return released;
    },
  };
}

describe('withMailbox', () => {
  it('locks read-only for reads and read-write for writes', async () => {
    const fake = fakeClient();
    await withMailbox(fake.client, 'INBOX', { access: 'read', from: 'query' }, () =>
      Promise.resolve(),
    );
    await withMailbox(fake.client, 'INBOX', { access: 'write', from: 'id' }, () =>
      Promise.resolve(),
    );
    expect(fake.locks).toEqual([
      { path: 'INBOX', options: { readOnly: true } },
      { path: 'INBOX', options: undefined },
    ]);
  });

  it('passes the uidValidity and releases the lock even when fn throws', async () => {
    const fake = fakeClient();
    await expect(
      withMailbox(fake.client, 'INBOX', { access: 'read', from: 'id' }, (v) =>
        Promise.reject(new Error(`boom ${v}`)),
      ),
    ).rejects.toThrow('boom 7');
    expect(fake.released).toBe(1);
  });

  it('turns a missing mailbox into mailbox_not_found with a hint matching the source', async () => {
    const fake = fakeClient([], true);
    const fromId = withMailbox(fake.client, 'Old', { access: 'read', from: 'id' }, () =>
      Promise.resolve(),
    );
    await expect(fromId).rejects.toMatchObject({ code: 'mailbox_not_found' });
    await expect(fromId).rejects.toThrow(/outdated/);
    await expect(
      withMailbox(fake.client, 'Old', { access: 'read', from: 'query' }, () => Promise.resolve()),
    ).rejects.toThrow(/list_labels/);
  });
});

describe('requireCapability', () => {
  it('refuses a missing capability with unsupported_server', () => {
    const call = (): void => {
      requireCapability(fakeClient(['MOVE']).client, 'UIDPLUS', 'update_draft');
    };
    expect(call).toThrow(MailError);
    expect(call).toThrow(expect.objectContaining({ code: 'unsupported_server' }));
    expect(call).toThrow('The mail server does not support UIDPLUS, which update_draft needs.');
  });

  it('accepts a present capability', () => {
    expect(() => {
      requireCapability(fakeClient(['UIDPLUS']).client, 'UIDPLUS', 'update_draft');
    }).not.toThrow();
  });
});
