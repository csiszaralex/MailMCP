import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImapPool } from '../../src/imap/pool.js';
import { ImapMailProvider } from '../../src/mail/imap-provider.js';
import { decodeMessageId, decodeThreadId } from '../../src/ids.js';
import { MailError } from '../../src/errors.js';
import { seed, startGreenMail, type GreenMail } from './greenmail.js';

let gm: GreenMail;
let pool: ImapPool;
let provider: ImapMailProvider;

beforeAll(async () => {
  gm = await startGreenMail();
  await seed(gm);
  pool = new ImapPool(gm.connect, 60_000);
  provider = new ImapMailProvider(gm.account, pool);
});

afterAll(async () => {
  await pool.closeAll();
  await gm.container.stop();
});

async function subjects(query: string): Promise<string[]> {
  return (await provider.search(query, 0, 20)).messages.map((m) => m.subject);
}

describe('search', () => {
  it('lists the inbox newest first', async () => {
    const page = await provider.search('', 0, 20);
    expect(page.total).toBe(3);
    expect(page.messages.map((m) => m.subject)).toEqual([
      'Lunch?',
      'Re: Invoice 2026-11',
      'Invoice 2026-11',
    ]);
  });

  it('pages with offset and limit', async () => {
    const page = await provider.search('', 1, 1);
    expect(page.total).toBe(3);
    expect(page.messages.map((m) => m.subject)).toEqual(['Re: Invoice 2026-11']);
  });

  it('filters by sender, flags, attachment and date', async () => {
    expect(await subjects('from:bob@example.com')).toEqual(['Invoice 2026-11']);
    expect(await subjects('is:unread')).toEqual(['Lunch?']);
    expect(await subjects('has:attachment')).toEqual(['Invoice 2026-11']);
    expect(await subjects('after:2026/11/11')).toEqual(['Lunch?', 'Re: Invoice 2026-11']);
  });

  it('searches another mailbox with in:', async () => {
    expect(await subjects('in:drafts')).toEqual(['Draft note']);
  });

  it('rejects Gmail-only syntax', async () => {
    await expect(provider.search('newer_than:7d', 0, 20)).rejects.toMatchObject({
      code: 'unsupported_query',
    });
  });
});

describe('getMessage', () => {
  it('returns the plain body and attachment list', async () => {
    // Full address: GreenMail 2.1.15 matches FROM only against the whole address or header
    // (measured: FROM bob -> no hit, FROM bob@example.com -> uid 1), although RFC 3501
    // defines a substring match. Real servers do substring matching.
    const [invoice] = (
      await provider.search('subject:"Invoice 2026-11" from:bob@example.com', 0, 1)
    ).messages;
    if (invoice === undefined) throw new Error('seed missing');
    const detail = await provider.getMessage(decodeMessageId(invoice.id), 'plain');
    expect(detail.body).toContain('Please find the invoice attached.');
    expect(detail.messageIdHeader).toBe('<m1@example.com>');
    expect(detail.attachments).toEqual([
      expect.objectContaining({ filename: 'invoice.pdf', mimeType: 'application/pdf' }),
    ]);
  });

  // imapflow fetches with BODY.PEEK[], so this stays green even under SELECT (measured);
  // the EXAMINE rule itself is pinned by 'opens every mailbox read-only' in gmail-provider.test.ts.
  it('returns html and does not mark the message as read', async () => {
    const [lunch] = (await provider.search('is:unread', 0, 1)).messages;
    if (lunch === undefined) throw new Error('seed missing');
    const detail = await provider.getMessage(decodeMessageId(lunch.id), 'html');
    expect(detail.body).toContain('<b>noon</b>');
    expect(await subjects('is:unread')).toEqual(['Lunch?']);
  });

  it('returns metadata without a body', async () => {
    const [first] = (await provider.search('', 0, 1)).messages;
    if (first === undefined) throw new Error('seed missing');
    const detail = await provider.getMessage(decodeMessageId(first.id), 'metadata');
    expect(detail.body).toBeNull();
  });

  it('rejects a stale uidValidity', async () => {
    const [first] = (await provider.search('', 0, 1)).messages;
    if (first === undefined) throw new Error('seed missing');
    const ref = { ...decodeMessageId(first.id), uidValidity: '999999' };
    const result = provider.getMessage(ref, 'plain');
    await expect(result).rejects.toBeInstanceOf(MailError);
    await expect(result).rejects.toMatchObject({ code: 'stale_id' });
  });

  it('rejects ids of another account', async () => {
    const [first] = (await provider.search('', 0, 1)).messages;
    if (first === undefined) throw new Error('seed missing');
    const ref = { ...decodeMessageId(first.id), account: 'other' };
    await expect(provider.getMessage(ref, 'plain')).rejects.toMatchObject({ code: 'invalid_id' });
  });
});

describe('getThread', () => {
  it('collects the reply chain by References', async () => {
    const [reply] = (await provider.search('subject:"Re: Invoice"', 0, 1)).messages;
    if (reply === undefined) throw new Error('seed missing');
    const thread = await provider.getThread(decodeThreadId(reply.threadId), 'plain');
    expect(thread.map((m) => m.subject)).toEqual(['Invoice 2026-11', 'Re: Invoice 2026-11']);
  });
});

describe('downloadAttachment', () => {
  it('returns the decoded file', async () => {
    const [invoice] = (await provider.search('has:attachment', 0, 1)).messages;
    if (invoice === undefined) throw new Error('seed missing');
    const ref = decodeMessageId(invoice.id);
    const detail = await provider.getMessage(ref, 'metadata');
    const attachment = detail.attachments[0];
    if (attachment === undefined) throw new Error('attachment missing');
    const content = await provider.downloadAttachment(ref, attachment.attachmentId);
    expect(content.filename).toBe('invoice.pdf');
    expect(content.data.toString('utf8')).toBe('fake pdf bytes');
  });

  it('reports a missing part', async () => {
    const [invoice] = (await provider.search('has:attachment', 0, 1)).messages;
    if (invoice === undefined) throw new Error('seed missing');
    await expect(
      provider.downloadAttachment(decodeMessageId(invoice.id), '9'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('labels and drafts', () => {
  // GreenMail sends no SPECIAL-USE flags; imapflow derives \Inbox and \Drafts from the
  // mailbox names (measured: specialUseSource "name"), so this covers the mapping, not the server.
  it('lists mailboxes with special-use flags', async () => {
    const labels = await provider.listLabels();
    expect(labels).toEqual(
      expect.arrayContaining([
        { name: 'INBOX', specialUse: expect.anything() as string },
        { name: 'Drafts', specialUse: '\\Drafts' },
      ]),
    );
  });

  it('lists drafts', async () => {
    const page = await provider.listDrafts(0, 10);
    expect(page.messages.map((m) => m.subject)).toEqual(['Draft note']);
  });
});
