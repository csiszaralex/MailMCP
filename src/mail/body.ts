import { simpleParser } from 'mailparser';
import { MailError } from '../errors.js';

export const RAW_LIMIT_BYTES = 5 * 1024 * 1024;
export const MAX_BODY_CHARS = 1_000_000;

export async function renderBody(
  source: Buffer,
  format: 'plain' | 'html' | 'raw',
): Promise<string> {
  if (format === 'raw') {
    if (source.length > RAW_LIMIT_BYTES) {
      throw new MailError(
        'too_large',
        `The raw message is larger than ${String(RAW_LIMIT_BYTES)} bytes.`,
      );
    }
    return source.toString('utf8');
  }
  const parsed = await simpleParser(source);
  const body =
    format === 'html'
      ? typeof parsed.html === 'string'
        ? parsed.html
        : (parsed.textAsHtml ?? '')
      : (parsed.text ?? '');
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n[truncated]` : body;
}
