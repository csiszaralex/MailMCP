import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_CHARS,
  RAW_LIMIT_BYTES,
  rawBody,
  renderText,
  type TextPart,
} from '../../src/mail/body.js';
import { MailError } from '../../src/errors.js';

function part(type: TextPart['type'], text: string, cut = false): TextPart {
  return { type, charset: 'utf-8', content: Buffer.from(text), cut };
}

const PLAIN = part('text/plain', 'Hello plain');
const HTML = part('text/html', '<p>Hello <b>html</b></p>');

describe('renderText', () => {
  it('returns the plain part', async () => {
    expect((await renderText([PLAIN], 'plain')).trim()).toBe('Hello plain');
  });

  it('returns the html part', async () => {
    expect(await renderText([HTML], 'html')).toContain('<b>html</b>');
  });

  it('falls back to textAsHtml when html is requested on a plain-only message', async () => {
    const html = await renderText([PLAIN], 'html');
    expect(html).not.toBe('');
    expect(html).toContain('Hello plain');
  });

  it('derives plain text from an html-only message', async () => {
    const text = await renderText([part('text/html', '<p>Lunch at <b>noon</b>?</p>')], 'plain');
    expect(text).toContain('noon');
    expect(text).not.toContain('<b>');
  });

  it('decodes the charset of a part', async () => {
    const latin1: TextPart = {
      type: 'text/plain',
      charset: 'iso-8859-2',
      content: Buffer.from([0x50, 0xf5, 0x7a]),
      cut: false,
    };
    expect((await renderText([latin1], 'plain')).trim()).toBe('Pőz');
  });

  it('truncates very long bodies', async () => {
    const body = await renderText([part('text/plain', 'a'.repeat(MAX_BODY_CHARS + 10))], 'plain');
    expect(body.endsWith('[truncated]')).toBe(true);
  });

  it('marks a body whose part was cut at the download limit', async () => {
    const body = await renderText([part('text/plain', 'start of a long part', true)], 'plain');
    expect(body.endsWith('[truncated]')).toBe(true);
  });
});

describe('rawBody', () => {
  it('returns the raw source', () => {
    expect(rawBody(Buffer.from('Subject: Hi\r\n\r\nbody'))).toContain('Subject: Hi');
  });

  it('rejects raw sources over the limit with too_large', () => {
    const big = Buffer.alloc(RAW_LIMIT_BYTES + 1, 'a');
    expect(() => rawBody(big)).toThrow(MailError);
    expect(() => rawBody(big)).toThrow(expect.objectContaining({ code: 'too_large' }) as Error);
  });
});
