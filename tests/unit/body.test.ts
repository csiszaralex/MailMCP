import { describe, expect, it } from 'vitest';
import { MAX_BODY_CHARS, RAW_LIMIT_BYTES, renderBody } from '../../src/mail/body.js';
import { MailError } from '../../src/errors.js';

const MULTI = Buffer.from(
  [
    'From: a@x.org',
    'To: b@x.org',
    'Subject: Hi',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hello plain',
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Hello <b>html</b></p>',
    '--b1--',
    '',
  ].join('\r\n'),
);

describe('renderBody', () => {
  it('returns the plain part', async () => {
    expect((await renderBody(MULTI, 'plain')).trim()).toBe('Hello plain');
  });

  it('returns the html part', async () => {
    expect(await renderBody(MULTI, 'html')).toContain('<b>html</b>');
  });

  it('returns the raw source', async () => {
    expect(await renderBody(MULTI, 'raw')).toContain('Subject: Hi');
  });

  it('falls back to textAsHtml when html is requested on a plain-only message', async () => {
    const plainOnly = Buffer.from(
      'Subject: x\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello plain',
    );
    const html = await renderBody(plainOnly, 'html');
    expect(html).not.toBe('');
    expect(html).toContain('Hello plain');
  });

  it('derives plain text from an html-only message', async () => {
    const htmlOnly = Buffer.from(
      'Subject: x\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Lunch at <b>noon</b>?</p>',
    );
    const text = await renderBody(htmlOnly, 'plain');
    expect(text).toContain('noon');
    expect(text).not.toContain('<b>');
  });

  it('rejects raw sources over the limit with too_large', async () => {
    const big = Buffer.alloc(RAW_LIMIT_BYTES + 1, 'a');
    const result = renderBody(big, 'raw');
    await expect(result).rejects.toBeInstanceOf(MailError);
    await expect(result).rejects.toMatchObject({ code: 'too_large' });
  });

  it('truncates very long bodies', async () => {
    const long = Buffer.from(`Subject: x\r\n\r\n${'a'.repeat(MAX_BODY_CHARS + 10)}`);
    const body = await renderBody(long, 'plain');
    expect(body.endsWith('[truncated]')).toBe(true);
  });
});
