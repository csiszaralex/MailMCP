import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Account } from '../../src/config/types.js';
import { decodeMessageId, decodeThreadId, type MessageRef } from '../../src/ids.js';
import { ImapPool } from '../../src/imap/pool.js';
import { ImapMailProvider } from '../../src/mail/imap-provider.js';
import { ImapMailWriter } from '../../src/mail/imap-writer.js';
import type {
  Composition,
  ForwardInput,
  MoveOutcome,
  ReplyInput,
  WriteTarget,
} from '../../src/mail/write-types.js';
import type { Envelope, SmtpSend } from '../../src/smtp/sender.js';
import { seed, startGreenMail, WRITE_MAILBOXES, type GreenMail } from './greenmail.js';

let gm: GreenMail;
let pool: ImapPool;
let account: Account;
let reader: ImapMailProvider;
let writer: ImapMailWriter;
/** Reads bob's mailbox, where alice's sent mail arrives. */
let bobReader: ImapMailProvider;

beforeAll(async () => {
  gm = await startGreenMail();
  await seed(gm);
  pool = new ImapPool(gm.connect, 60_000);
  account = { ...gm.account, mailboxes: WRITE_MAILBOXES };
  reader = new ImapMailProvider(account, pool);
  writer = new ImapMailWriter(account, pool, reader, gm.send);
  bobReader = new ImapMailProvider(gm.bob, pool);
});

afterAll(async () => {
  await pool.closeAll();
  await gm.container.stop();
});

function composition(fields: Partial<Composition>): Composition {
  return {
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    body: undefined,
    htmlBody: undefined,
    attachments: [],
    includeSignature: false,
    ...fields,
  };
}

async function inboxRef(subject: string): Promise<MessageRef> {
  const [found] = (await reader.search(`subject:"${subject}"`, 0, 10)).messages.filter(
    (m) => m.subject === subject,
  );
  if (found === undefined) throw new Error(`seed message "${subject}" missing`);
  return decodeMessageId(found.id);
}

async function subjectsIn(query: string): Promise<string[]> {
  return (await reader.search(query, 0, 50)).messages.map((m) => m.subject);
}

describe('createDraft', () => {
  it('creates a draft that list_drafts and get_draft see', async () => {
    const out = await writer.createDraft(
      composition({ to: ['bob@example.com'], subject: 'Plan', body: 'Draft body' }),
      undefined,
    );
    const draft = await reader.getMessage(decodeMessageId(out.draftId), 'plain');
    expect(draft.subject).toBe('Plan');
    expect(draft.flags).toEqual(expect.arrayContaining(['\\Draft', '\\Seen']));
    expect(draft.body?.trim()).toBe('Draft body');
    expect(draft.from[0]?.address).toBe('alice@example.com');
    expect(out.warnings).toEqual([]);
    const listed = (await reader.listDrafts(0, 50)).messages.map((m) => m.id);
    expect(listed).toContain(out.draftId);
  });

  it('keeps Bcc in the stored draft', async () => {
    const out = await writer.createDraft(
      composition({ to: ['bob@example.com'], bcc: ['eve@example.com'], subject: 'Secret' }),
      undefined,
    );
    const raw = await reader.getMessage(decodeMessageId(out.draftId), 'raw');
    expect(raw.body).toContain('Bcc: eve@example.com');
  });

  it('creates a reply draft with quoting and threading headers', async () => {
    const original = await inboxRef('Invoice 2026-11');
    const out = await writer.createDraft(composition({ body: 'Got it.' }), original);
    const draft = await reader.getMessage(decodeMessageId(out.draftId), 'plain');
    expect(draft.subject).toBe('Re: Invoice 2026-11');
    expect(draft.inReplyTo).toBe('<m1@example.com>');
    expect(draft.body).toContain('Got it.');
    expect(draft.body).toContain('> Please find the invoice attached.');
    // R2: no recipients given, so they come from the original (Bob, its sender).
    expect(draft.to.map((a) => a.address)).toEqual(['bob@example.com']);
    const raw = await reader.getMessage(decodeMessageId(out.draftId), 'raw');
    expect(raw.body).toContain('References: <m1@example.com>');
  });

  it('extends the References chain of a reply to a reply', async () => {
    const original = await inboxRef('Re: Invoice 2026-11');
    const out = await writer.createDraft(composition({ body: 'Thanks.' }), original);
    const raw = await reader.getMessage(decodeMessageId(out.draftId), 'raw');
    expect(raw.body).toContain('References: <m1@example.com> <m2@example.com>');
    // The original was sent by alice herself, so the reply goes to its recipients (D19).
    const draft = await reader.getMessage(decodeMessageId(out.draftId), 'plain');
    expect(draft.subject).toBe('Re: Invoice 2026-11');
    expect(draft.to.map((a) => a.address)).toEqual(['bob@example.com']);
  });

  it('keeps explicit recipients of a reply draft', async () => {
    const original = await inboxRef('Invoice 2026-11');
    const out = await writer.createDraft(
      composition({ to: ['carol@example.com'], subject: 'Own subject', body: 'x' }),
      original,
    );
    const draft = await reader.getMessage(decodeMessageId(out.draftId), 'plain');
    expect(draft.to.map((a) => a.address)).toEqual(['carol@example.com']);
    expect(draft.subject).toBe('Own subject');
  });

  it('addresses a reply to a note-to-self to the account itself', async () => {
    const client = await gm.connect(gm.account);
    try {
      const note = [
        'From: alice@example.com',
        'To: alice@example.com',
        'Subject: Note to self',
        'Message-ID: <self1@example.com>',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Remember the milk.',
        '',
      ].join('\r\n');
      await client.append('INBOX', Buffer.from(note), ['\\Seen']);
    } finally {
      await client.logout();
    }
    const out = await writer.createDraft(
      composition({ body: 'Done.' }),
      await inboxRef('Note to self'),
    );
    const draft = await reader.getMessage(decodeMessageId(out.draftId), 'plain');
    expect(draft.to.map((a) => a.address)).toEqual(['alice@example.com']);
  });

  it('adds the signature when asked', async () => {
    const signed = new ImapMailWriter({ ...account, signature: 'Alice A.' }, pool, reader, gm.send);
    const out = await signed.createDraft(
      composition({
        to: ['bob@example.com'],
        subject: 'Signed',
        body: 'Hello',
        includeSignature: true,
      }),
      undefined,
    );
    const draft = await reader.getMessage(decodeMessageId(out.draftId), 'plain');
    expect(draft.body).toContain('Hello\n\n-- \nAlice A.');
  });
});

describe('updateDraft', () => {
  it('updates only the given fields and returns a new id', async () => {
    const first = await writer.createDraft(
      composition({ to: ['bob@example.com'], subject: 'Old', body: 'Old body' }),
      undefined,
    );
    const second = await writer.updateDraft(decodeMessageId(first.draftId), {
      subject: 'New',
      attachments: [],
    });
    expect(second.draftId).not.toBe(first.draftId);
    expect(second.warnings).toEqual([]);
    const draft = await reader.getMessage(decodeMessageId(second.draftId), 'plain');
    expect([draft.subject, draft.body?.trim(), draft.to[0]?.address]).toEqual([
      'New',
      'Old body',
      'bob@example.com',
    ]);
    expect(draft.flags).toEqual(expect.arrayContaining(['\\Draft', '\\Seen']));
    await expect(reader.getMessage(decodeMessageId(first.draftId), 'plain')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('replaces the attachments and keeps the threading headers', async () => {
    const original = await inboxRef('Invoice 2026-11');
    const first = await writer.createDraft(
      composition({
        body: 'With file',
        attachments: [
          {
            content: Buffer.from('one').toString('base64'),
            filename: 'one.txt',
            mimeType: 'text/plain',
            inline: false,
          },
        ],
      }),
      original,
    );
    const second = await writer.updateDraft(decodeMessageId(first.draftId), {
      body: 'New text',
      attachments: [
        {
          content: Buffer.from('two').toString('base64'),
          filename: 'two.txt',
          mimeType: 'text/plain',
          inline: false,
        },
      ],
    });
    const draft = await reader.getMessage(decodeMessageId(second.draftId), 'plain');
    expect(draft.attachments.map((a) => a.filename)).toEqual(['two.txt']);
    expect(draft.body?.trim()).toBe('New text');
    expect(draft.inReplyTo).toBe('<m1@example.com>');
    expect(draft.subject).toBe('Re: Invoice 2026-11');
  });

  it('refuses a message outside the drafts mailbox and leaves it in place', async () => {
    const ref = await inboxRef('Lunch?');
    await expect(writer.updateDraft(ref, { subject: 'x', attachments: [] })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(writer.deleteDraft(ref)).rejects.toMatchObject({ code: 'not_found' });
    expect((await reader.getMessage(ref, 'metadata')).subject).toBe('Lunch?');
  });
});

describe('deleteDraft', () => {
  it('moves a deleted draft to the trash', async () => {
    const out = await writer.createDraft(
      composition({ to: ['bob@example.com'], subject: 'Throwaway draft', body: 'bye' }),
      undefined,
    );
    const moved = await writer.deleteDraft(decodeMessageId(out.draftId));
    expect(moved.warnings).toEqual([]);
    expect(moved.messageIds).toHaveLength(1);
    expect(await subjectsIn('in:trash')).toContain('Throwaway draft');
    expect(await subjectsIn('in:drafts')).not.toContain('Throwaway draft');
    const [trashedId] = moved.messageIds;
    if (trashedId === undefined) throw new Error('no id');
    const trashed = await reader.getMessage(decodeMessageId(trashedId), 'plain');
    expect(trashed.subject).toBe('Throwaway draft');
    expect(trashed.mailbox).toBe('Trash');
  });
});

/** Appends a fresh message, so these tests never consume the shared seed messages. */
async function appendFresh(path: string, subject: string, headers: string[] = []): Promise<void> {
  const client = await gm.connect(gm.account);
  try {
    const raw = [
      'From: Carol <carol@example.com>',
      'To: alice@example.com',
      `Subject: ${subject}`,
      ...headers,
      'Content-Type: text/plain; charset=utf-8',
      '',
      `${subject} body`,
      '',
    ].join('\r\n');
    await client.append(path, Buffer.from(raw), []);
  } finally {
    await client.logout();
  }
}

async function refIn(path: string, subject: string): Promise<MessageRef> {
  const [found] = (await reader.search(`in:${path} subject:"${subject}"`, 0, 10)).messages.filter(
    (m) => m.subject === subject,
  );
  if (found === undefined) throw new Error(`message "${subject}" missing from ${path}`);
  return decodeMessageId(found.id);
}

async function freshRef(path: string, subject: string): Promise<MessageRef> {
  await appendFresh(path, subject);
  return refIn(path, subject);
}

function message(ref: MessageRef): WriteTarget {
  return { kind: 'message', ref };
}

/** Two INBOX messages of one thread; returns its thread id as get_message reports it. */
async function freshThread(root: string, subject: string): Promise<WriteTarget> {
  await appendFresh('INBOX', subject, [`Message-ID: <${root}>`]);
  await appendFresh('INBOX', `Re: ${subject}`, [
    `Message-ID: <reply-${root}>`,
    `In-Reply-To: <${root}>`,
    `References: <${root}>`,
  ]);
  const detail = await reader.getMessage(await refIn('INBOX', subject), 'metadata');
  return { kind: 'thread', ref: decodeThreadId(detail.threadId) };
}

function onlyId(out: MoveOutcome): MessageRef {
  expect(out.warnings).toEqual([]);
  expect(out.messageIds).toHaveLength(1);
  const [id] = out.messageIds;
  if (id === undefined) throw new Error('no id');
  return decodeMessageId(id);
}

describe('updateLabels', () => {
  it('marks read and starred with flags', async () => {
    const ref = await freshRef('INBOX', 'Flag me');
    const out = await writer.updateLabels(message(ref), { add: ['STARRED'], remove: ['UNREAD'] });
    expect(onlyId(out)).toEqual(ref);
    const flags = (await reader.getMessage(ref, 'metadata')).flags;
    expect(flags).toEqual(expect.arrayContaining(['\\Seen', '\\Flagged']));
  });

  it('moves to a folder by adding it as a label and returns the new id', async () => {
    const ref = await freshRef('INBOX', 'File me');
    const out = await writer.updateLabels(message(ref), { add: ['Newsletters'], remove: [] });
    const moved = onlyId(out);
    expect(moved.mailbox).toBe('Newsletters');
    expect((await reader.getMessage(moved, 'metadata')).subject).toBe('File me');
    expect(await subjectsIn('in:inbox')).not.toContain('File me');
  });

  it('sets the flags and then moves when both are asked', async () => {
    const ref = await freshRef('INBOX', 'Star and file me');
    const moved = onlyId(
      await writer.updateLabels(message(ref), { add: ['STARRED', 'Newsletters'], remove: [] }),
    );
    expect(moved.mailbox).toBe('Newsletters');
    expect((await reader.getMessage(moved, 'metadata')).flags).toContain('\\Flagged');
  });

  it('archives by removing INBOX', async () => {
    const ref = await freshRef('INBOX', 'Archive me');
    const moved = onlyId(await writer.updateLabels(message(ref), { add: [], remove: ['INBOX'] }));
    expect(moved.mailbox).toBe('Archive');
    expect(await subjectsIn('in:Archive')).toContain('Archive me');
  });

  it('refuses two folders at once', async () => {
    const ref = await freshRef('INBOX', 'Two folders');
    await expect(
      writer.updateLabels(message(ref), { add: ['Newsletters', 'Forwards'], remove: [] }),
    ).rejects.toMatchObject({ code: 'unsupported_query' });
    expect((await reader.getMessage(ref, 'metadata')).mailbox).toBe('INBOX');
  });

  it('sets no flag when the folder to move to does not exist', async () => {
    const ref = await freshRef('INBOX', 'Missing folder');
    await expect(
      writer.updateLabels(message(ref), { add: ['STARRED', 'NoSuchFolder'], remove: [] }),
    ).rejects.toMatchObject({ code: 'mailbox_not_found' });
    const after = await reader.getMessage(ref, 'metadata');
    expect([after.mailbox, after.flags.includes('\\Flagged')]).toEqual(['INBOX', false]);
  });

  it('refuses the other folder combinations and changes no flag', async () => {
    const ref = await freshRef('INBOX', 'Odd combination');
    await expect(
      writer.updateLabels(message(ref), { add: ['STARRED', 'Newsletters'], remove: ['INBOX'] }),
    ).rejects.toMatchObject({ code: 'unsupported_query' });
    await expect(
      writer.updateLabels(message(ref), { add: [], remove: ['Newsletters'] }),
    ).rejects.toMatchObject({ code: 'unsupported_query' });
    const filed = await freshRef('Newsletters', 'Not in the inbox');
    await expect(
      writer.updateLabels(message(filed), { add: [], remove: ['INBOX'] }),
    ).rejects.toMatchObject({ code: 'unsupported_query' });
    expect((await reader.getMessage(ref, 'metadata')).flags).not.toContain('\\Flagged');
  });
});

describe('trash and spam', () => {
  it('trashes and restores a message to INBOX', async () => {
    const ref = await freshRef('INBOX', 'Trash me');
    const trashed = onlyId(await writer.trash(message(ref)));
    expect(trashed.mailbox).toBe('Trash');
    expect(await subjectsIn('in:trash')).toContain('Trash me');
    const restored = onlyId(await writer.untrash(message(trashed)));
    expect(restored.mailbox).toBe('INBOX');
    expect((await reader.getMessage(restored, 'metadata')).subject).toBe('Trash me');
    expect(await subjectsIn('in:trash')).not.toContain('Trash me');
  });

  it('marks a message as spam and back', async () => {
    const ref = await freshRef('INBOX', 'Spam me');
    const junk = onlyId(await writer.markSpam(message(ref)));
    expect(junk.mailbox).toBe('Junk');
    const restored = onlyId(await writer.unmarkSpam(message(junk)));
    expect(restored.mailbox).toBe('INBOX');
  });

  it('trashes a whole thread and restores it with the same thread id', async () => {
    const thread = await freshThread('t7-trash@example.com', 'Thread to trash');
    expect((await writer.trash(thread)).messageIds).toHaveLength(2);
    expect(await subjectsIn('in:trash')).toEqual(
      expect.arrayContaining(['Thread to trash', 'Re: Thread to trash']),
    );
    expect(await subjectsIn('in:inbox')).not.toContain('Thread to trash');
    // The thread id still names INBOX: untrash searches the trash instead (threadLocation's mailbox).
    const restored = await writer.untrash(thread);
    expect(restored.messageIds.map((id) => decodeMessageId(id).mailbox)).toEqual([
      'INBOX',
      'INBOX',
    ]);
    expect(await subjectsIn('in:trash')).not.toContain('Thread to trash');
  });

  it('restores a whole thread from spam with the same thread id', async () => {
    const thread = await freshThread('t7-spam@example.com', 'Thread to junk');
    expect((await writer.markSpam(thread)).messageIds).toHaveLength(2);
    expect((await writer.unmarkSpam(thread)).messageIds).toHaveLength(2);
    expect(await subjectsIn('in:inbox')).toEqual(
      expect.arrayContaining(['Thread to junk', 'Re: Thread to junk']),
    );
    expect(await subjectsIn('in:spam')).not.toContain('Thread to junk');
  });

  it('restores only ids that are in the trash or spam', async () => {
    const ref = await freshRef('INBOX', 'Never trashed');
    await expect(writer.untrash(message(ref))).rejects.toMatchObject({ code: 'not_found' });
    const trashed = onlyId(await writer.trash(message(await freshRef('INBOX', 'Only trashed'))));
    await expect(writer.unmarkSpam(message(trashed))).rejects.toMatchObject({
      code: 'not_found',
    });
    // Both ids still name their message where it was: nothing moved.
    expect((await reader.getMessage(ref, 'metadata')).subject).toBe('Never trashed');
    expect((await reader.getMessage(trashed, 'metadata')).subject).toBe('Only trashed');
  });

  it('reports a thread with no message in the trash as not found', async () => {
    const thread = await freshThread('t7-none@example.com', 'Thread never trashed');
    await expect(writer.untrash(thread)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('manageLabel', () => {
  it('deletes only empty folders and never system ones', async () => {
    await writer.manageLabel({ action: 'create', name: 'Empty' });
    await writer.manageLabel({ action: 'delete', name: 'Empty' });
    expect((await reader.listLabels()).map((l) => l.name)).not.toContain('Empty');
    await expect(
      writer.manageLabel({ action: 'delete', name: 'Newsletters' }),
    ).rejects.toMatchObject({ code: 'not_permitted' });
    await expect(
      writer.manageLabel({ action: 'rename', name: 'Trash', newName: 'Bin' }),
    ).rejects.toMatchObject({ code: 'not_permitted' });
    await expect(
      writer.manageLabel({ action: 'rename', name: 'INBOX', newName: 'Old' }),
    ).rejects.toMatchObject({ code: 'not_permitted' });
    await expect(writer.manageLabel({ action: 'delete', name: 'Junk' })).rejects.toMatchObject({
      code: 'not_permitted',
    });
  });

  it('creates idempotently and renames a folder', async () => {
    await writer.manageLabel({ action: 'create', name: 'Projects' });
    await writer.manageLabel({ action: 'create', name: 'Projects' });
    await writer.manageLabel({ action: 'rename', name: 'Projects', newName: 'Clients' });
    const names = (await reader.listLabels()).map((l) => l.name);
    expect(names).toContain('Clients');
    expect(names).not.toContain('Projects');
  });

  it('reports a missing folder', async () => {
    await expect(writer.manageLabel({ action: 'delete', name: 'Nowhere' })).rejects.toMatchObject({
      code: 'mailbox_not_found',
    });
  });
});

function replyInput(fields: Partial<ReplyInput>): ReplyInput {
  return {
    body: undefined,
    htmlBody: undefined,
    attachments: [],
    includeSignature: false,
    replyAll: false,
    to: undefined,
    cc: undefined,
    bcc: [],
    ...fields,
  };
}

function forwardInput(fields: Partial<ForwardInput>): ForwardInput {
  return {
    to: [],
    cc: [],
    bcc: [],
    forwardText: undefined,
    htmlBody: undefined,
    attachments: [],
    includeSignature: false,
    ...fields,
  };
}

/** The one message bob received with exactly this subject. */
async function receivedByBob(subject: string): Promise<MessageRef> {
  const found = (await bobReader.search(`subject:"${subject}"`, 0, 10)).messages.filter(
    (m) => m.subject === subject,
  );
  expect(found).toHaveLength(1);
  const [only] = found;
  if (only === undefined) throw new Error(`bob did not receive "${subject}"`);
  return decodeMessageId(only.id);
}

/** A writer whose SMTP records every envelope before delivering through GreenMail. */
function recordingWriter(): { writer: ImapMailWriter; envelopes: Envelope[] } {
  const envelopes: Envelope[] = [];
  const send: SmtpSend = (acc, raw, envelope) => {
    envelopes.push(envelope);
    return gm.send(acc, raw, envelope);
  };
  return { writer: new ImapMailWriter(account, pool, reader, send), envelopes };
}

describe('send', () => {
  it('delivers without Bcc and keeps Bcc in the sent copy', async () => {
    const out = await writer.send(
      composition({
        to: ['bob@example.com'],
        bcc: ['alice@example.com'],
        subject: 'Hello Bob',
        body: 'Hi',
      }),
    );
    expect(out.warnings).toEqual([]);
    const raw = await bobReader.getMessage(await receivedByBob('Hello Bob'), 'raw');
    expect(raw.body).not.toMatch(/^Bcc:/im);
    expect(raw.body).toContain(`Message-ID: ${out.messageIdHeader}`);
    if (out.sentCopyId === null) throw new Error('no sent copy');
    const copyRef = decodeMessageId(out.sentCopyId);
    expect(copyRef.mailbox).toBe('Sent');
    const copy = await reader.getMessage(copyRef, 'raw');
    expect(copy.body).toMatch(/^Bcc: alice@example\.com/im);
    expect(copy.flags).toContain('\\Seen');
  });

  it('delivers to the Bcc recipient through the envelope', async () => {
    const recording = recordingWriter();
    await recording.writer.send(
      composition({
        to: ['bob@example.com'],
        cc: ['carol@example.com'],
        bcc: ['dave@example.com'],
        subject: 'Envelope check',
        body: 'Hi',
      }),
    );
    expect(recording.envelopes).toEqual([
      {
        from: 'alice@example.com',
        to: ['bob@example.com', 'carol@example.com', 'dave@example.com'],
      },
    ]);
  });
});

describe('sendDraft', () => {
  it('sends a draft and removes it', async () => {
    const draft = await writer.createDraft(
      composition({
        to: ['bob@example.com'],
        bcc: ['dave@example.com'],
        subject: 'Draft to send',
        body: 'From the drafts',
      }),
      undefined,
    );
    const out = await writer.sendDraft(decodeMessageId(draft.draftId));
    expect(out.warnings).toEqual([]);
    const received = await bobReader.getMessage(await receivedByBob('Draft to send'), 'raw');
    expect(received.body).toContain('From the drafts');
    expect(received.body).not.toMatch(/^Bcc:/im);
    expect(await subjectsIn('in:drafts')).not.toContain('Draft to send');
    expect(await subjectsIn('in:sent')).toContain('Draft to send');
  });

  it('refuses a message outside the drafts mailbox and leaves it in place', async () => {
    const ref = await freshRef('INBOX', 'Not a draft to send');
    await expect(writer.sendDraft(ref)).rejects.toMatchObject({ code: 'not_found' });
    expect((await reader.getMessage(ref, 'metadata')).subject).toBe('Not a draft to send');
  });
});

describe('reply', () => {
  it('replies in the thread with quoting', async () => {
    const original = await inboxRef('Invoice 2026-11');
    const out = await writer.reply(original, replyInput({ body: 'Paid today.' }));
    expect(out.warnings).toEqual([]);
    const ref = await receivedByBob('Re: Invoice 2026-11');
    const received = await bobReader.getMessage(ref, 'plain');
    expect(received.inReplyTo).toBe('<m1@example.com>');
    expect(received.body).toContain('Paid today.');
    expect(received.body).toContain('> Please find the invoice attached.');
    const raw = await bobReader.getMessage(ref, 'raw');
    expect(raw.body).toContain('References: <m1@example.com>');
  });

  it('reply all skips our own plus address', async () => {
    const client = await gm.connect(gm.account);
    try {
      const team = [
        'From: Bob <bob@example.com>',
        'To: alice+x@example.com, Carol <carol@example.com>',
        'Subject: Team plan',
        'Message-ID: <team1@example.com>',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Who joins?',
        '',
      ].join('\r\n');
      await client.append('INBOX', Buffer.from(team), ['\\Seen']);
    } finally {
      await client.logout();
    }
    const recording = recordingWriter();
    await recording.writer.reply(
      await inboxRef('Team plan'),
      replyInput({ body: 'Me.', replyAll: true }),
    );
    expect(recording.envelopes).toEqual([
      { from: 'alice@example.com', to: ['bob@example.com', 'carol@example.com'] },
    ]);
  });
});

describe('forward', () => {
  it('forwards with the original attachment', async () => {
    const original = await inboxRef('Invoice 2026-11');
    const out = await writer.forward(
      original,
      forwardInput({ to: ['bob@example.com'], forwardText: 'FYI' }),
    );
    expect(out.warnings).toEqual([]);
    const ref = await receivedByBob('Fwd: Invoice 2026-11');
    const received = await bobReader.getMessage(ref, 'plain');
    expect(received.attachments.map((a) => a.filename)).toEqual(['invoice.pdf']);
    expect(received.inReplyTo).toBeNull();
    expect(received.body).toContain('FYI');
    expect(received.body).toContain('---------- Forwarded message ---------');
    expect(received.body).toContain('Please find the invoice attached.');
  });
});
