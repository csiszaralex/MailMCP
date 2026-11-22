import { describe, expect, it } from 'vitest';
import type {
  FetchMessageObject,
  ListResponse,
  MailboxLockOptions,
  MailboxObject,
  SearchObject,
} from 'imapflow';
import { ImapMailProvider } from '../../src/mail/imap-provider.js';
import { ImapPool } from '../../src/imap/pool.js';
import type { ImapClient } from '../../src/imap/client.js';
import type { Account } from '../../src/config/types.js';
import { decodeThreadId } from '../../src/ids.js';

const ACCOUNT: Account = {
  id: 'personal',
  owner: 'alex',
  address: 'personal@example.com',
  username: 'personal@example.com',
  provider: 'gmail',
  level: 'read',
  signature: undefined,
  imap: { host: 'imap.gmail.com', port: 993 },
  smtp: { host: 'smtp.gmail.com', port: 465 },
  mailboxes: {},
};

const ALL_MAIL = '[Gmail]/Összes levél';

function fakeGmail(messages: FetchMessageObject[]) {
  const searches: { mailbox: string; query: SearchObject }[] = [];
  const locks: { path: string; options: MailboxLockOptions | undefined }[] = [];
  let opened = '';
  const client = {
    usable: true,
    get mailbox(): MailboxObject {
      return { path: opened, uidValidity: 5n } as MailboxObject;
    },
    list: () =>
      Promise.resolve([
        { path: 'INBOX', specialUse: '\\Inbox' },
        { path: ALL_MAIL, specialUse: '\\All' },
      ] as Partial<ListResponse>[] as ListResponse[]),
    getMailboxLock: (path: string, options?: MailboxLockOptions) => {
      locks.push({ path, options });
      opened = path;
      return Promise.resolve({ path, release: () => undefined });
    },
    search: (query: SearchObject) => {
      searches.push({ mailbox: opened, query });
      return Promise.resolve(messages.map((m) => m.uid));
    },
    fetchAll: () => Promise.resolve(messages),
    on: () => undefined,
    logout: () => Promise.resolve(),
  } as Partial<ImapClient> as ImapClient;
  return { client, searches, locks };
}

describe('ImapMailProvider on Gmail', () => {
  const message: FetchMessageObject = {
    seq: 1,
    uid: 77,
    threadId: '1790000000000000001',
    labels: new Set(['\\Inbox', 'Work']),
    flags: new Set(['\\Seen']),
    envelope: { subject: 'Hello', date: new Date('2026-11-20T10:00:00Z') },
  };

  it('passes the query to X-GM-RAW in All Mail and returns Gmail thread ids', async () => {
    const fake = fakeGmail([message]);
    const provider = new ImapMailProvider(
      ACCOUNT,
      new ImapPool(() => Promise.resolve(fake.client)),
    );
    const page = await provider.search('from:bob newer_than:7d', 0, 20);
    expect(fake.searches).toEqual([
      { mailbox: ALL_MAIL, query: { gmraw: 'from:bob newer_than:7d' } },
    ]);
    expect(page.messages[0]?.labels).toEqual(['\\Inbox', 'Work']);
    expect(decodeThreadId(page.messages[0]?.threadId ?? '')).toEqual({
      kind: 'gmail',
      account: 'personal',
      gmailThreadId: '1790000000000000001',
    });
  });

  it('searches threads by X-GM-THRID', async () => {
    const fake = fakeGmail([message]);
    const provider = new ImapMailProvider(
      ACCOUNT,
      new ImapPool(() => Promise.resolve(fake.client)),
    );
    await provider.getThread(
      { kind: 'gmail', account: 'personal', gmailThreadId: '1790000000000000001' },
      'metadata',
    );
    expect(fake.searches).toEqual([
      { mailbox: ALL_MAIL, query: { threadId: '1790000000000000001' } },
    ]);
  });

  // The GreenMail test cannot catch a read-write SELECT: imapflow fetches with BODY.PEEK[],
  // which leaves \Seen unset either way (measured), so the EXAMINE rule is checked here.
  it('opens every mailbox read-only', async () => {
    const fake = fakeGmail([message]);
    const provider = new ImapMailProvider(
      ACCOUNT,
      new ImapPool(() => Promise.resolve(fake.client)),
    );
    await provider.search('', 0, 20);
    await provider.getMessage(
      { account: 'personal', mailbox: ALL_MAIL, uidValidity: '5', uid: 77 },
      'metadata',
    );
    await provider.getThread(
      { kind: 'gmail', account: 'personal', gmailThreadId: '1790000000000000001' },
      'metadata',
    );
    expect(fake.locks).toEqual([
      { path: ALL_MAIL, options: { readOnly: true } },
      { path: ALL_MAIL, options: { readOnly: true } },
      { path: ALL_MAIL, options: { readOnly: true } },
    ]);
  });
});
