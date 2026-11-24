import { describe, expect, it } from 'vitest';
import type {
  AppendResponseObject,
  CopyResponseObject,
  FetchMessageObject,
  FetchQueryObject,
  MailboxObject,
} from 'imapflow';
import type { Account } from '../../src/config/types.js';
import type { ImapClient } from '../../src/imap/client.js';
import { ImapPool } from '../../src/imap/pool.js';
import { MailError } from '../../src/errors.js';
import {
  ImapMailWriter,
  OLD_DRAFT_KEPT_WARNING,
  rejectedRecipientsWarning,
  SENT_COPY_FAILED_WARNING,
} from '../../src/mail/imap-writer.js';
import { STORED_MESSAGE_LIMIT_BYTES } from '../../src/mail/stored.js';
import type { MailProvider } from '../../src/mail/types.js';
import type { SmtpSend } from '../../src/smtp/sender.js';
import type { Composition, DraftPatch } from '../../src/mail/write-types.js';

const ACCOUNT: Account = {
  id: 'work',
  owner: 'alex',
  address: 'info@example.org',
  username: 'info@example.org',
  provider: 'imap',
  level: 'draft',
  signature: undefined,
  imap: { host: 'mail.example.org', port: 993 },
  smtp: { host: 'mail.example.org', port: 465 },
  mailboxes: { drafts: 'Drafts', sent: 'Sent', trash: 'Trash' },
};

const STORED = Buffer.from(
  [
    'From: info@example.org',
    'To: bob@example.org',
    'Subject: Old',
    'Message-ID: <d1@example.org>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Old body',
    '',
  ].join('\r\n'),
);

const REF = { account: 'work', mailbox: 'Drafts', uidValidity: '9', uid: 4 };
const PATCH: DraftPatch = { subject: 'New', attachments: [] };

interface FakeOptions {
  capabilities: string[];
  size?: number;
  deleteResult?: boolean | 'throw';
  moveResult?: CopyResponseObject | false;
  storeResult?: boolean;
  appendResult?: AppendResponseObject | false;
}

interface Fake {
  client: ImapClient;
  /** Names of the client methods called, in order. */
  calls: string[];
  fetchQueries: FetchQueryObject[];
}

function fakeWith(options: FakeOptions): Fake {
  const calls: string[] = [];
  const fetchQueries: FetchQueryObject[] = [];
  const client = {
    usable: true,
    capabilities: new Map(options.capabilities.map((c) => [c, true])),
    get mailbox(): MailboxObject {
      return { path: 'Drafts', uidValidity: 9n } as MailboxObject;
    },
    getMailboxLock: (path: string) => {
      calls.push('getMailboxLock');
      return Promise.resolve({ path, release: () => undefined });
    },
    fetchOne: (uid: string, query: FetchQueryObject) => {
      calls.push('fetchOne');
      fetchQueries.push(query);
      const msg: FetchMessageObject = {
        seq: Number(uid),
        uid: Number(uid),
        size: options.size ?? STORED.length,
        envelope: { messageId: '<new@example.org>' },
        ...(query.source === undefined ? {} : { source: STORED }),
      };
      return Promise.resolve(msg);
    },
    append: (path: string) => {
      calls.push('append');
      const res: AppendResponseObject = { destination: path, uid: 5, uidValidity: 9n };
      return Promise.resolve(options.appendResult ?? res);
    },
    search: () => {
      calls.push('search');
      return Promise.resolve([4]);
    },
    messageFlagsAdd: () => {
      calls.push('messageFlagsAdd');
      return Promise.resolve(options.storeResult ?? true);
    },
    messageFlagsRemove: () => {
      calls.push('messageFlagsRemove');
      return Promise.resolve(options.storeResult ?? true);
    },
    messageDelete: () => {
      calls.push('messageDelete');
      if (options.deleteResult === 'throw') return Promise.reject(new Error('NO'));
      return Promise.resolve(options.deleteResult ?? true);
    },
    messageMove: () => {
      calls.push('messageMove');
      return Promise.resolve(
        options.moveResult ?? {
          path: 'Drafts',
          destination: 'Trash',
          uidValidity: 3n,
          uidMap: new Map([[4, 11]]),
        },
      );
    },
    on: () => undefined,
    logout: () => Promise.resolve(),
  } as Partial<ImapClient> as ImapClient;
  return { client, calls, fetchQueries };
}

const UNUSED_READER = {} as MailProvider;

const DELIVERED = { rejected: [] };

function writer(fake: Fake, smtp: SmtpSend = () => Promise.resolve(DELIVERED)): ImapMailWriter {
  return new ImapMailWriter(
    ACCOUNT,
    new ImapPool(() => Promise.resolve(fake.client)),
    UNUSED_READER,
    smtp,
  );
}

const MESSAGE: Composition = {
  to: ['bob@example.org'],
  cc: [],
  bcc: [],
  subject: 'Hi',
  body: 'x',
  htmlBody: undefined,
  attachments: [],
  includeSignature: false,
};

/** An SmtpSend that records how often it was called. */
function countingSmtp(): { send: SmtpSend; calls: () => number } {
  let count = 0;
  return {
    send: () => {
      count += 1;
      return Promise.resolve(DELIVERED);
    },
    calls: () => count,
  };
}

const CHANGES = ['append', 'messageDelete', 'messageMove', 'messageFlagsAdd', 'messageFlagsRemove'];

describe('ImapMailWriter capability checks', () => {
  it('changes nothing when UIDPLUS is missing', async () => {
    const fake = fakeWith({ capabilities: ['MOVE'] });
    await expect(writer(fake).updateDraft(REF, PATCH)).rejects.toMatchObject({
      code: 'unsupported_server',
    });
    expect(fake.calls.filter((c) => CHANGES.includes(c))).toEqual([]);
  });

  it('creates no draft without UIDPLUS', async () => {
    const fake = fakeWith({ capabilities: ['MOVE'] });
    const composition = {
      to: ['bob@example.org'],
      cc: [],
      bcc: [],
      subject: 'Hi',
      body: 'x',
      htmlBody: undefined,
      attachments: [],
      includeSignature: false,
    };
    await expect(writer(fake).createDraft(composition, undefined)).rejects.toMatchObject({
      code: 'unsupported_server',
    });
    expect(fake.calls.filter((c) => CHANGES.includes(c))).toEqual([]);
  });

  it('moves nothing without MOVE', async () => {
    const fake = fakeWith({ capabilities: ['UIDPLUS'] });
    await expect(writer(fake).deleteDraft(REF)).rejects.toMatchObject({
      code: 'unsupported_server',
    });
    expect(fake.calls.filter((c) => CHANGES.includes(c))).toEqual([]);
  });

  it('sets no flag without MOVE when the label change also moves', async () => {
    const fake = fakeWith({ capabilities: ['UIDPLUS'] });
    await expect(
      writer(fake).updateLabels(
        { kind: 'message', ref: REF },
        { add: ['STARRED', 'Newsletters'], remove: [] },
      ),
    ).rejects.toMatchObject({ code: 'unsupported_server' });
    expect(fake.calls.filter((c) => CHANGES.includes(c))).toEqual([]);
  });

  it('sets flags without MOVE when nothing moves', async () => {
    const fake = fakeWith({ capabilities: ['UIDPLUS'] });
    await writer(fake).updateLabels(
      { kind: 'message', ref: REF },
      { add: ['STARRED'], remove: [] },
    );
    expect(fake.calls.filter((c) => CHANGES.includes(c))).toEqual(['messageFlagsAdd']);
  });
});

describe('ImapMailWriter.updateLabels', () => {
  it('reports flags the server refused', async () => {
    const fake = fakeWith({ capabilities: ['UIDPLUS', 'MOVE'], storeResult: false });
    await expect(
      writer(fake).updateLabels({ kind: 'message', ref: REF }, { add: ['STARRED'], remove: [] }),
    ).rejects.toMatchObject({ code: 'update_failed' });
  });
});

describe('ImapMailWriter.updateDraft', () => {
  it('appends the new version before removing the old one', async () => {
    const fake = fakeWith({ capabilities: ['UIDPLUS', 'MOVE'] });
    const out = await writer(fake).updateDraft(REF, PATCH);
    expect(out.warnings).toEqual([]);
    expect(fake.calls.filter((c) => CHANGES.includes(c))).toEqual(['append', 'messageDelete']);
  });

  it('reports a failed removal of the old version as a warning', async () => {
    const fake = fakeWith({ capabilities: ['UIDPLUS', 'MOVE'], deleteResult: false });
    expect((await writer(fake).updateDraft(REF, PATCH)).warnings).toEqual([OLD_DRAFT_KEPT_WARNING]);
  });

  it('reports a thrown removal error as a warning', async () => {
    const fake = fakeWith({ capabilities: ['UIDPLUS', 'MOVE'], deleteResult: 'throw' });
    expect((await writer(fake).updateDraft(REF, PATCH)).warnings).toEqual([OLD_DRAFT_KEPT_WARNING]);
  });

  it('refuses a draft over the size limit before downloading it', async () => {
    const fake = fakeWith({
      capabilities: ['UIDPLUS', 'MOVE'],
      size: STORED_MESSAGE_LIMIT_BYTES + 1,
    });
    await expect(writer(fake).updateDraft(REF, PATCH)).rejects.toMatchObject({
      code: 'too_large',
    });
    expect(fake.fetchQueries.every((q) => q.source === undefined)).toBe(true);
    expect(fake.calls.filter((c) => CHANGES.includes(c))).toEqual([]);
  });

  it('rejects a stale id and an id of another account', async () => {
    const fake = fakeWith({ capabilities: ['UIDPLUS', 'MOVE'] });
    await expect(
      writer(fake).updateDraft({ ...REF, uidValidity: '8' }, PATCH),
    ).rejects.toMatchObject({ code: 'stale_id' });
    await expect(
      writer(fake).updateDraft({ ...REF, account: 'other' }, PATCH),
    ).rejects.toMatchObject({ code: 'unknown_account' });
    expect(fake.calls.filter((c) => CHANGES.includes(c))).toEqual([]);
  });
});

describe('ImapMailWriter.deleteDraft', () => {
  it('returns the new id from the uid map', async () => {
    const fake = fakeWith({ capabilities: ['UIDPLUS', 'MOVE'] });
    const out = await writer(fake).deleteDraft(REF);
    expect(out.messageIds).toHaveLength(1);
    expect(out.warnings).toEqual([]);
  });

  it('warns about a message the uid map does not list', async () => {
    const fake = fakeWith({
      capabilities: ['UIDPLUS', 'MOVE'],
      moveResult: { path: 'Drafts', destination: 'Trash' },
    });
    const out = await writer(fake).deleteDraft(REF);
    expect(out.messageIds).toEqual([]);
    expect(out.warnings).toHaveLength(1);
  });
});

describe('ImapMailWriter.send', () => {
  it('writes nothing when SMTP fails', async () => {
    const fake = fakeWith({ capabilities: ['UIDPLUS', 'MOVE'] });
    const failing: SmtpSend = () => Promise.reject(new MailError('send_failed', 'refused'));
    await expect(writer(fake, failing).send(MESSAGE)).rejects.toMatchObject({
      code: 'send_failed',
    });
    expect(fake.calls).toEqual([]);
  });

  it('sends nothing without a recipient', async () => {
    const fake = fakeWith({ capabilities: ['UIDPLUS', 'MOVE'] });
    const smtp = countingSmtp();
    await expect(writer(fake, smtp.send).send({ ...MESSAGE, to: [] })).rejects.toMatchObject({
      code: 'send_failed',
    });
    expect(smtp.calls()).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it('stores a sent copy and returns its id', async () => {
    const fake = fakeWith({ capabilities: ['UIDPLUS', 'MOVE'] });
    const out = await writer(fake).send(MESSAGE);
    expect(out.sentCopyId).not.toBeNull();
    expect(out.warnings).toEqual([]);
    expect(out.messageIdHeader).toMatch(/^<.+@example\.org>$/);
  });

  it('names the recipients the server rejected in a warning', async () => {
    const fake = fakeWith({ capabilities: ['UIDPLUS', 'MOVE'] });
    const smtp: SmtpSend = () => Promise.resolve({ rejected: ['carol@example.org'] });
    const out = await writer(fake, smtp).send({ ...MESSAGE, cc: ['carol@example.org'] });
    expect(out.warnings).toEqual([rejectedRecipientsWarning(['carol@example.org'])]);
    expect(out.warnings[0]).toContain('carol@example.org');
    expect(out.sentCopyId).not.toBeNull();
  });

  it('reports a failed sent copy as a warning', async () => {
    const fake = fakeWith({ capabilities: ['UIDPLUS', 'MOVE'], appendResult: false });
    const out = await writer(fake).send(MESSAGE);
    expect(out.sentCopyId).toBeNull();
    expect(out.warnings).toEqual([SENT_COPY_FAILED_WARNING]);
  });
});

describe('ImapMailWriter.sendDraft', () => {
  it('sends a draft only with UIDPLUS', async () => {
    const fake = fakeWith({ capabilities: ['MOVE'] });
    const smtp = countingSmtp();
    await expect(writer(fake, smtp.send).sendDraft(REF)).rejects.toMatchObject({
      code: 'unsupported_server',
    });
    expect(smtp.calls()).toBe(0);
    expect(fake.calls.filter((c) => CHANGES.includes(c))).toEqual([]);
  });

  it('removes the draft only after the send', async () => {
    const fake = fakeWith({ capabilities: ['UIDPLUS', 'MOVE'] });
    const order: string[] = [];
    const smtp: SmtpSend = () => {
      order.push(...fake.calls.filter((c) => CHANGES.includes(c)), 'smtp');
      return Promise.resolve(DELIVERED);
    };
    const out = await writer(fake, smtp).sendDraft(REF);
    expect(out.warnings).toEqual([]);
    expect(order).toEqual(['smtp']);
    expect(fake.calls.filter((c) => CHANGES.includes(c))).toEqual(['append', 'messageDelete']);
  });
});
