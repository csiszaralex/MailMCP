import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Account } from '../../src/config/types.js';
import { decodeMessageId, type MessageRef } from '../../src/ids.js';
import { ImapPool } from '../../src/imap/pool.js';
import { ImapMailProvider } from '../../src/mail/imap-provider.js';
import { ImapMailWriter } from '../../src/mail/imap-writer.js';
import type { Composition } from '../../src/mail/write-types.js';
import { seed, startGreenMail, WRITE_MAILBOXES, type GreenMail } from './greenmail.js';

let gm: GreenMail;
let pool: ImapPool;
let account: Account;
let reader: ImapMailProvider;
let writer: ImapMailWriter;

beforeAll(async () => {
  gm = await startGreenMail();
  await seed(gm);
  pool = new ImapPool(gm.connect, 60_000);
  account = { ...gm.account, mailboxes: WRITE_MAILBOXES };
  reader = new ImapMailProvider(account, pool);
  writer = new ImapMailWriter(account, pool, reader, gm.send);
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
