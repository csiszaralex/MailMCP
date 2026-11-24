import { describe, expect, it } from 'vitest';
import type {
  CopyResponseObject,
  ListResponse,
  MailboxObject,
  SearchObject,
  StoreOptions,
} from 'imapflow';
import type { Account } from '../../src/config/types.js';
import { decodeMessageId, type MessageRef } from '../../src/ids.js';
import type { ImapClient } from '../../src/imap/client.js';
import { ImapPool } from '../../src/imap/pool.js';
import { ImapMailWriter } from '../../src/mail/imap-writer.js';
import type { MailProvider } from '../../src/mail/types.js';
import type { WriteTarget } from '../../src/mail/write-types.js';
import type { SmtpSend } from '../../src/smtp/sender.js';

const ACCOUNT: Account = {
  id: 'personal',
  owner: 'alex',
  address: 'personal@example.com',
  username: 'personal@example.com',
  provider: 'gmail',
  level: 'send',
  signature: undefined,
  imap: { host: 'imap.gmail.com', port: 993 },
  smtp: { host: 'smtp.gmail.com', port: 465 },
  mailboxes: {},
};

const ALL_MAIL = '[Gmail]/Összes levél';
const TRASH = '[Gmail]/Kuka';
const SPAM = '[Gmail]/Spam';

const REF: MessageRef = { account: 'personal', mailbox: ALL_MAIL, uidValidity: '5', uid: 77 };

interface Store {
  op: 'add' | 'remove';
  flags: string[];
  useLabels: boolean;
}

function fakeGmail(
  capabilities: string[] = ['MOVE', 'UIDPLUS', 'X-GM-EXT-1'],
  storeResult = true,
  labelMessages = 12,
) {
  const stores: Store[] = [];
  const moves: { from: string; range: string; destination: string }[] = [];
  const searches: { mailbox: string; query: SearchObject }[] = [];
  const calls: string[] = [];
  let opened = '';
  const store = (op: Store['op']) => (_range: string, flags: string[], options: StoreOptions) => {
    calls.push('store');
    stores.push({ op, flags, useLabels: options.useLabels === true });
    return Promise.resolve(storeResult);
  };
  const client = {
    usable: true,
    capabilities: new Map(capabilities.map((c) => [c, true])),
    get mailbox(): MailboxObject {
      return { path: opened, uidValidity: 5n } as MailboxObject;
    },
    list: () =>
      Promise.resolve([
        { path: 'INBOX', specialUse: '\\Inbox', flags: new Set<string>() },
        { path: ALL_MAIL, specialUse: '\\All', flags: new Set<string>() },
        { path: TRASH, specialUse: '\\Trash', flags: new Set<string>() },
        { path: SPAM, specialUse: '\\Junk', flags: new Set<string>() },
        { path: 'Work', flags: new Set<string>() },
      ] as Partial<ListResponse>[] as ListResponse[]),
    getMailboxLock: (path: string) => {
      opened = path;
      return Promise.resolve({ path, release: () => undefined });
    },
    search: (query: SearchObject) => {
      searches.push({ mailbox: opened, query });
      return Promise.resolve([77]);
    },
    messageFlagsAdd: store('add'),
    messageFlagsRemove: store('remove'),
    messageMove: (range: string, destination: string) => {
      calls.push('messageMove');
      moves.push({ from: opened, range, destination });
      const res: CopyResponseObject = {
        path: opened,
        destination,
        uidValidity: 8n,
        uidMap: new Map([[77, 300]]),
      };
      return Promise.resolve(res);
    },
    mailboxDelete: (path: string) => {
      calls.push('mailboxDelete');
      return Promise.resolve({ path });
    },
    append: () => {
      calls.push('append');
      return Promise.resolve(false);
    },
    status: () => {
      calls.push('status');
      return Promise.resolve({ path: 'Work', messages: labelMessages });
    },
    on: () => undefined,
    logout: () => Promise.resolve(),
  } as Partial<ImapClient> as ImapClient;
  return { client, stores, moves, searches, calls };
}

function writerFor(
  fake: { client: ImapClient },
  smtp: SmtpSend = () => Promise.resolve({ rejected: [] }),
): ImapMailWriter {
  return new ImapMailWriter(
    ACCOUNT,
    new ImapPool(() => Promise.resolve(fake.client)),
    {} as MailProvider,
    smtp,
  );
}

function message(ref: MessageRef): WriteTarget {
  return { kind: 'message', ref };
}

const THREAD: WriteTarget = {
  kind: 'thread',
  ref: { kind: 'gmail', account: 'personal', gmailThreadId: '1790000000000000001' },
};

describe('ImapMailWriter on Gmail', () => {
  it('stores Gmail labels with useLabels and flags without', async () => {
    const fake = fakeGmail();
    const out = await writerFor(fake).updateLabels(message(REF), {
      add: ['Work', 'STARRED'],
      remove: ['INBOX', 'UNREAD'],
    });
    expect(fake.stores).toEqual([
      { op: 'add', flags: ['Work'], useLabels: true },
      { op: 'remove', flags: ['\\Inbox'], useLabels: true },
      { op: 'add', flags: ['\\Flagged', '\\Seen'], useLabels: false },
    ]);
    // Labels do not move a Gmail message: its id stays the same.
    expect(out.messageIds.map(decodeMessageId)).toEqual([REF]);
    expect(fake.moves).toEqual([]);
  });

  it('maps IMPORTANT and removes flags for UNREAD and unstarring', async () => {
    const fake = fakeGmail();
    await writerFor(fake).updateLabels(THREAD, {
      add: ['IMPORTANT', 'UNREAD'],
      remove: ['STARRED'],
    });
    expect(fake.searches).toEqual([
      { mailbox: ALL_MAIL, query: { threadId: '1790000000000000001' } },
    ]);
    expect(fake.stores).toEqual([
      { op: 'add', flags: ['\\Important'], useLabels: true },
      { op: 'remove', flags: ['\\Flagged', '\\Seen'], useLabels: false },
    ]);
  });

  it('refuses TRASH and SPAM as labels', async () => {
    const fake = fakeGmail();
    for (const name of ['TRASH', 'SPAM']) {
      await expect(
        writerFor(fake).updateLabels(message(REF), { add: [name], remove: [] }),
      ).rejects.toMatchObject({ code: 'unsupported_query' });
    }
    expect(fake.stores).toEqual([]);
  });

  it('stores no label without X-GM-EXT-1', async () => {
    const fake = fakeGmail(['MOVE', 'UIDPLUS']);
    await expect(
      writerFor(fake).updateLabels(message(REF), { add: ['Work'], remove: [] }),
    ).rejects.toMatchObject({ code: 'unsupported_server' });
    expect(fake.calls).toEqual([]);
  });

  it('reports a label change the server refused', async () => {
    const fake = fakeGmail(undefined, false);
    await expect(
      writerFor(fake).updateLabels(message(REF), { add: ['Work'], remove: [] }),
    ).rejects.toMatchObject({ code: 'update_failed' });
    // The first refusal stops the change: the flags are not tried after it.
    expect(fake.calls).toEqual(['store']);
  });

  it('refuses to restore an id that is not in the trash or spam', async () => {
    const fake = fakeGmail();
    await expect(writerFor(fake).untrash(message(REF))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      writerFor(fake).unmarkSpam(message({ ...REF, mailbox: TRASH })),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(fake.moves).toEqual([]);
    expect(fake.searches).toEqual([]);
  });

  it('restores Gmail mail from the trash to All Mail', async () => {
    const fake = fakeGmail();
    const trashed: MessageRef = { ...REF, mailbox: TRASH };
    const out = await writerFor(fake).untrash(message(trashed));
    expect(fake.moves).toEqual([{ from: TRASH, range: '77', destination: ALL_MAIL }]);
    expect(out.messageIds.map((id) => decodeMessageId(id).mailbox)).toEqual([ALL_MAIL]);
  });

  it('looks for a restored thread in the spam folder', async () => {
    const fake = fakeGmail();
    await writerFor(fake).unmarkSpam(THREAD);
    expect(fake.searches).toEqual([{ mailbox: SPAM, query: { threadId: '1790000000000000001' } }]);
    expect(fake.moves).toEqual([{ from: SPAM, range: '77', destination: ALL_MAIL }]);
  });

  it('trashes a thread from All Mail', async () => {
    const fake = fakeGmail();
    await writerFor(fake).trash(THREAD);
    expect(fake.moves).toEqual([{ from: ALL_MAIL, range: '77', destination: TRASH }]);
  });

  it('changes nothing without MOVE', async () => {
    const fake = fakeGmail(['UIDPLUS', 'X-GM-EXT-1']);
    await expect(writerFor(fake).trash(message(REF))).rejects.toMatchObject({
      code: 'unsupported_server',
    });
    await expect(writerFor(fake).markSpam(THREAD)).rejects.toMatchObject({
      code: 'unsupported_server',
    });
    expect(fake.calls).toEqual([]);
  });

  it('refuses to delete a Gmail label that still holds messages', async () => {
    const fake = fakeGmail();
    // Which messages carried the label could not be restored (D23).
    await expect(
      writerFor(fake).manageLabel({ action: 'delete', name: 'Work' }),
    ).rejects.toMatchObject({
      code: 'not_permitted',
      message: 'The folder still holds 12 messages; move them out first.',
    });
    expect(fake.calls).toEqual(['status']);
  });

  it('deletes an empty Gmail label', async () => {
    const fake = fakeGmail(undefined, undefined, 0);
    await writerFor(fake).manageLabel({ action: 'delete', name: 'Work' });
    expect(fake.calls).toEqual(['status', 'mailboxDelete']);
  });

  it('never deletes or renames a system label', async () => {
    const fake = fakeGmail();
    await expect(
      writerFor(fake).manageLabel({ action: 'delete', name: ALL_MAIL }),
    ).rejects.toMatchObject({ code: 'not_permitted' });
    await expect(
      writerFor(fake).manageLabel({ action: 'rename', name: 'INBOX', newName: 'Old' }),
    ).rejects.toMatchObject({ code: 'not_permitted' });
    expect(fake.calls).toEqual([]);
  });

  it('keeps no sent copy for Gmail', async () => {
    const fake = fakeGmail();
    let sent = 0;
    const smtp: SmtpSend = () => {
      sent += 1;
      return Promise.resolve({ rejected: [] });
    };
    const out = await writerFor(fake, smtp).send({
      to: ['friend@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hi',
      body: 'x',
      htmlBody: undefined,
      attachments: [],
      includeSignature: false,
    });
    expect(sent).toBe(1);
    // Gmail SMTP stores the sent message itself (D18).
    expect(fake.calls).toEqual([]);
    expect(out.sentCopyId).toBeNull();
    expect(out.warnings).toEqual([]);
  });
});
