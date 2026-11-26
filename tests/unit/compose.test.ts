import { simpleParser, type AddressObject } from 'mailparser';
import { describe, expect, it } from 'vitest';
import type { Account } from '../../src/config/types.js';
import {
  OUTGOING_ATTACHMENTS_LIMIT_BYTES,
  assertAttachmentBudget,
  buildMime,
  decodeAttachments,
  forwardBody,
  newMessageId,
  prefixSubject,
  quoteReply,
  withSignature,
  type MimeSpec,
  type QuotedOriginal,
} from '../../src/mail/compose.js';
import type { Address } from '../../src/mail/types.js';
import type { OutgoingAttachment } from '../../src/mail/write-types.js';

const alice: Address = { name: 'Alice', address: 'alice@example.org' };
const bob: Address = { name: 'Bob', address: 'bob@example.org' };
const eve: Address = { name: '', address: 'eve@example.org' };

function b64(text: string): string {
  return Buffer.from(text).toString('base64');
}

function textOf(value: AddressObject | AddressObject[] | undefined): string {
  if (value === undefined) return '';
  return (Array.isArray(value) ? value : [value]).map((v) => v.text).join(', ');
}

function spec(overrides: Partial<MimeSpec> = {}): MimeSpec {
  return {
    from: 'Alice <alice@example.org>',
    to: [bob],
    cc: [],
    bcc: [],
    subject: 'Hello',
    text: 'Body',
    html: undefined,
    attachments: [],
    inReplyTo: undefined,
    references: [],
    messageId: '<id-1@example.org>',
    date: new Date('2026-11-10T08:00:00.000Z'),
    ...overrides,
  };
}

function account(address: string): Account {
  return {
    id: 'acc',
    owner: 'alex',
    address,
    username: address,
    provider: 'imap',
    level: 'send',
    signature: undefined,
    imap: { host: 'imap.example.org', port: 993 },
    smtp: { host: 'smtp.example.org', port: 465 },
    mailboxes: {},
  };
}

const pdfAttachment: OutgoingAttachment = {
  content: b64('pdf'),
  filename: 'a.pdf',
  mimeType: 'application/pdf',
  inline: false,
};
const pngAttachment: OutgoingAttachment = {
  content: b64('png'),
  filename: 'b.png',
  mimeType: 'image/png',
  inline: false,
};

const original: QuotedOriginal = {
  from: [bob],
  date: '2026-11-10T08:00:00.000Z',
  subject: 'Inner',
  to: [alice],
  text: 'line one\nline two',
  html: undefined,
};

describe('buildMime', () => {
  it('leaves Bcc out unless keepBcc', async () => {
    const sent = await simpleParser(await buildMime(spec({ bcc: [eve] }), { keepBcc: false }));
    expect(sent.bcc).toBeUndefined();
    const copy = await simpleParser(await buildMime(spec({ bcc: [eve] }), { keepBcc: true }));
    expect(textOf(copy.bcc)).toContain('eve@example.org');
  });

  it('encodes accented subjects and file names', async () => {
    const parsed = await simpleParser(
      await buildMime(
        spec({
          subject: 'Számla ő ű',
          attachments: decodeAttachments([
            {
              content: b64('pdf'),
              filename: 'Számla ő ű.pdf',
              mimeType: 'application/pdf',
              inline: false,
            },
          ]),
        }),
        { keepBcc: false },
      ),
    );
    expect(parsed.subject).toBe('Számla ő ű');
    expect(parsed.attachments[0]?.filename).toBe('Számla ő ű.pdf');
  });

  it('refuses attachments over the limit', async () => {
    const big = {
      content: Buffer.alloc(OUTGOING_ATTACHMENTS_LIMIT_BYTES + 1),
      filename: 'big.bin',
      contentType: 'application/octet-stream',
      cid: undefined,
    };
    await expect(buildMime(spec({ attachments: [big] }), { keepBcc: false })).rejects.toMatchObject(
      { code: 'too_large' },
    );
  });

  it('sets reply headers', async () => {
    const parsed = await simpleParser(
      await buildMime(
        spec({
          inReplyTo: '<orig@example.org>',
          references: ['<root@example.org>', '<orig@example.org>'],
        }),
        { keepBcc: false },
      ),
    );
    expect(parsed.inReplyTo).toBe('<orig@example.org>');
    expect(parsed.references).toEqual(['<root@example.org>', '<orig@example.org>']);
    expect(parsed.messageId).toBe('<id-1@example.org>');
  });

  it('writes an empty text part when neither text nor html is given', async () => {
    const raw = await buildMime(spec({ text: undefined, html: undefined }), { keepBcc: false });
    expect(raw.toString()).toContain('Content-Type: text/plain');
    expect((await simpleParser(raw)).text?.trim() ?? '').toBe('');
  });

  it('embeds inline attachments by cid', async () => {
    const parsed = await simpleParser(
      await buildMime(
        spec({
          text: undefined,
          html: '<img src="cid:att0">',
          attachments: decodeAttachments([{ ...pngAttachment, inline: true }]),
        }),
        { keepBcc: false },
      ),
    );
    expect(parsed.attachments[0]?.cid).toBe('att0');
  });
});

describe('buildMime recipients', () => {
  it('does not let a display name add or replace recipients', async () => {
    const parsed = await simpleParser(
      await buildMime(
        spec({
          to: [{ name: 'x@attacker.example, Bob', address: 'bob@example.org' }],
          cc: [{ name: 'Bob "the" <boss@example.org>', address: 'carol@example.org' }],
          bcc: [{ name: 'y@attacker.example, Eve', address: 'eve@example.org' }],
        }),
        { keepBcc: true },
      ),
    );
    const addresses = (v: AddressObject | AddressObject[] | undefined): string[] =>
      (v === undefined ? [] : Array.isArray(v) ? v : [v]).flatMap((o) =>
        o.value.map((a) => a.address ?? ''),
      );
    expect(addresses(parsed.to)).toEqual(['bob@example.org']);
    expect(addresses(parsed.cc)).toEqual(['carol@example.org']);
    expect(addresses(parsed.bcc)).toEqual(['eve@example.org']);
  });
});

describe('decodeAttachments', () => {
  it('numbers inline attachments as attN over the whole list', () => {
    const [pdf, png] = decodeAttachments([pdfAttachment, { ...pngAttachment, inline: true }]);
    expect(pdf?.cid).toBeUndefined();
    expect(png?.cid).toBe('att1');
  });

  it('decodes base64 and defaults the content type', () => {
    const [att] = decodeAttachments([{ ...pdfAttachment, mimeType: undefined }]);
    expect(att?.content.toString()).toBe('pdf');
    expect(att?.contentType).toBe('application/octet-stream');
  });
});

describe('assertAttachmentBudget', () => {
  it('accepts exactly the limit', () => {
    expect(() => {
      assertAttachmentBudget([
        {
          content: Buffer.alloc(OUTGOING_ATTACHMENTS_LIMIT_BYTES),
          filename: undefined,
          contentType: 'application/octet-stream',
          cid: undefined,
        },
      ]);
    }).not.toThrow();
  });
});

describe('newMessageId', () => {
  it('uses the domain of the account address', () => {
    expect(newMessageId(account('alex@mail.example.org'))).toMatch(
      /^<[0-9a-f-]{36}@mail\.example\.org>$/,
    );
  });
});

describe('quoteReply', () => {
  it('quotes the original below the reply', () => {
    expect(quoteReply(original, 'Thanks', undefined).text).toBe(
      'Thanks\n\nOn 2026-11-10T08:00:00.000Z, Bob <bob@example.org> wrote:\n> line one\n> line two',
    );
  });

  it('uses the bare address when the name is empty', () => {
    expect(quoteReply({ ...original, from: [eve] }, 'Hi', undefined).text).toContain(
      ', eve@example.org wrote:',
    );
  });

  it('quotes html in a blockquote, escaping the text fallback', () => {
    const plain = quoteReply({ ...original, text: 'a < b' }, undefined, '<p>Hi</p>').html;
    expect(plain).toContain('<blockquote>a &lt; b</blockquote>');
    const rich = quoteReply({ ...original, html: '<p>Orig</p>' }, undefined, '<p>Hi</p>').html;
    expect(rich).toContain('<blockquote><p>Orig</p></blockquote>');
    expect(rich?.startsWith('<p>Hi</p>')).toBe(true);
  });
});

describe('withSignature', () => {
  it('escapes the signature in html', () => {
    expect(withSignature(undefined, '<p>Hi</p>', 'A & B\nAlex').html).toBe(
      '<p>Hi</p><br><br>-- <br>A &amp; B<br>Alex',
    );
  });

  it('appends the text signature', () => {
    expect(withSignature('Hi', undefined, 'Alex').text).toBe('Hi\n\n-- \nAlex');
  });

  it('leaves everything alone without a signature', () => {
    expect(withSignature('Hi', '<p>Hi</p>', undefined)).toEqual({
      text: 'Hi',
      html: '<p>Hi</p>',
    });
  });
});

describe('prefixSubject', () => {
  it('does not stack Re: prefixes', () => {
    expect(prefixSubject('Re:', 'RE: x')).toBe('RE: x');
  });

  it('adds the prefix otherwise', () => {
    expect(prefixSubject('Fwd:', 'x')).toBe('Fwd: x');
  });
});

describe('forwardBody', () => {
  it('forwards with a header block', () => {
    const { text, html } = forwardBody(original, 'FYI', undefined);
    expect(text).toContain('---------- Forwarded message ---------');
    expect(text).toContain('From: Bob <bob@example.org>');
    expect(text).toContain('Subject: Inner');
    expect(text).toContain('To: Alice <alice@example.org>');
    expect(text.endsWith('line one\nline two')).toBe(true);
    expect(html).toBeUndefined();
  });
});
