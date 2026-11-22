import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type {
  DownloadObject,
  FetchMessageObject,
  FetchQueryObject,
  MailboxObject,
  MessageStructureObject,
} from 'imapflow';
import { ImapMailProvider, THREAD_MESSAGE_LIMIT } from '../../src/mail/imap-provider.js';
import { ImapPool } from '../../src/imap/pool.js';
import type { ImapClient } from '../../src/imap/client.js';
import type { Account } from '../../src/config/types.js';
import { RAW_LIMIT_BYTES } from '../../src/mail/body.js';

const ACCOUNT: Account = {
  id: 'work',
  owner: 'alex',
  address: 'info@example.org',
  username: 'info@example.org',
  provider: 'imap',
  level: 'read',
  signature: undefined,
  imap: { host: 'mail.example.org', port: 993 },
  smtp: { host: 'mail.example.org', port: 465 },
  mailboxes: {},
};

/** A mail with a short text part and a 30 MB attachment. */
const STRUCTURE: MessageStructureObject = {
  type: 'multipart/mixed',
  childNodes: [
    { part: '1', type: 'text/plain', parameters: { charset: 'utf-8' }, size: 11 },
    {
      part: '2',
      type: 'application/pdf',
      disposition: 'attachment',
      dispositionParameters: { filename: 'big.pdf' },
      size: 30 * 1024 * 1024,
    },
  ],
};

interface Fake {
  client: ImapClient;
  fetchQueries: FetchQueryObject[];
  downloads: { uid: string; part: string }[];
}

function fakeServer(uids: number[], searchResult: number[] | false = uids): Fake {
  const fetchQueries: FetchQueryObject[] = [];
  const downloads: { uid: string; part: string }[] = [];
  const message = (uid: number): FetchMessageObject => ({
    seq: uid,
    uid,
    size: 30 * 1024 * 1024 + 500,
    bodyStructure: STRUCTURE,
    envelope: { subject: `mail ${String(uid)}`, messageId: `<m${String(uid)}@example.org>` },
  });
  const client = {
    usable: true,
    get mailbox(): MailboxObject {
      return { path: 'INBOX', uidValidity: 9n } as MailboxObject;
    },
    getMailboxLock: (path: string) => Promise.resolve({ path, release: () => undefined }),
    search: () => Promise.resolve(searchResult),
    fetchAll: (_range: string, query: FetchQueryObject) => {
      fetchQueries.push(query);
      return Promise.resolve(uids.map(message));
    },
    fetchOne: (uid: string, query: FetchQueryObject) => {
      fetchQueries.push(query);
      return Promise.resolve(message(Number(uid)));
    },
    download: (uid: string, part: string) => {
      downloads.push({ uid, part });
      const result: DownloadObject = {
        meta: { contentType: 'text/plain', charset: 'utf-8' },
        content: Readable.from([Buffer.from('Hello text\n')]),
      };
      return Promise.resolve(result);
    },
    on: () => undefined,
    logout: () => Promise.resolve(),
  } as Partial<ImapClient> as ImapClient;
  return { client, fetchQueries, downloads };
}

function providerFor(fake: Fake): ImapMailProvider {
  return new ImapMailProvider(ACCOUNT, new ImapPool(() => Promise.resolve(fake.client)));
}

const REF = { account: 'work', mailbox: 'INBOX', uidValidity: '9', uid: 4 };

describe('ImapMailProvider body download', () => {
  it('downloads only the text part for the plain format', async () => {
    const fake = fakeServer([4]);
    const detail = await providerFor(fake).getMessage(REF, 'plain');
    expect(detail.body?.trim()).toBe('Hello text');
    expect(detail.truncated).toBe(false);
    expect(fake.fetchQueries.every((q) => q.source === undefined)).toBe(true);
    expect(fake.downloads).toEqual([{ uid: '4', part: '1' }]);
  });

  it('downloads each thread message on its own, never the full source', async () => {
    const fake = fakeServer([4, 5]);
    const thread = await providerFor(fake).getThread(
      { kind: 'references', account: 'work', mailbox: 'INBOX', rootMessageId: '<m4@example.org>' },
      'plain',
    );
    expect(thread.messages).toHaveLength(2);
    expect(fake.fetchQueries.every((q) => q.source === undefined)).toBe(true);
    expect(fake.downloads).toEqual([
      { uid: '4', part: '1' },
      { uid: '5', part: '1' },
    ]);
  });

  it('refuses a raw message over the limit before downloading it', async () => {
    const fake = fakeServer([4]);
    await expect(providerFor(fake).getMessage(REF, 'raw')).rejects.toMatchObject({
      code: 'too_large',
    });
    expect(fake.fetchQueries.every((q) => q.source === undefined)).toBe(true);
    expect(RAW_LIMIT_BYTES).toBeLessThan(30 * 1024 * 1024);
  });
});

describe('ImapMailProvider search failures', () => {
  it('reports a search the server refused instead of an empty result', async () => {
    const fake = fakeServer([], false);
    await expect(providerFor(fake).search('from:bob@example.org', 0, 20)).rejects.toMatchObject({
      code: 'search_failed',
    });
  });

  it('reports a refused thread search', async () => {
    const fake = fakeServer([], false);
    await expect(
      providerFor(fake).getThread(
        { kind: 'references', account: 'work', mailbox: 'INBOX', rootMessageId: '<m@example.org>' },
        'metadata',
      ),
    ).rejects.toMatchObject({ code: 'search_failed' });
  });

  it('reports a thread without messages as not_found', async () => {
    const fake = fakeServer([]);
    await expect(
      providerFor(fake).getThread(
        { kind: 'references', account: 'work', mailbox: 'INBOX', rootMessageId: '<m@example.org>' },
        'metadata',
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('ImapMailProvider long threads', () => {
  it('keeps the newest messages and reports how many older ones were left out', async () => {
    const uids = Array.from({ length: THREAD_MESSAGE_LIMIT + 5 }, (_, i) => i + 1);
    const fake = fakeServer(uids);
    const thread = await providerFor(fake).getThread(
      { kind: 'references', account: 'work', mailbox: 'INBOX', rootMessageId: '<m1@example.org>' },
      'metadata',
    );
    expect(thread.olderOmitted).toBe(5);
    expect(thread.messages).toHaveLength(THREAD_MESSAGE_LIMIT);
    expect(thread.messages[0]?.subject).toBe('mail 6');
    expect(thread.messages.at(-1)?.subject).toBe(`mail ${String(THREAD_MESSAGE_LIMIT + 5)}`);
  });
});
