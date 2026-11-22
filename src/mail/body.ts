import { simpleParser } from 'mailparser';
import { MailError } from '../errors.js';
import type { TextType } from './message-parts.js';

export const RAW_LIMIT_BYTES = 5 * 1024 * 1024;
export const MAX_BODY_CHARS = 1_000_000;
/** Decoded bytes read from one text part; a longer part is cut and the body marked truncated. */
export const TEXT_PART_LIMIT_BYTES = 2 * 1024 * 1024;

/** One downloaded text part, transfer encoding already removed. */
export interface TextPart {
  type: TextType;
  charset: string | undefined;
  content: Buffer;
  /** The part was longer than TEXT_PART_LIMIT_BYTES and content holds only its start. */
  cut: boolean;
}

/** Throws too_large for a raw message over the limit; checked on the server's size before downloading. */
export function assertRawSize(bytes: number): void {
  if (bytes > RAW_LIMIT_BYTES) {
    throw new MailError(
      'too_large',
      `The raw message is larger than ${String(RAW_LIMIT_BYTES)} bytes.`,
    );
  }
}

export function rawBody(source: Buffer): string {
  assertRawSize(source.length);
  return source.toString('utf8');
}

/** Wraps a decoded part in a minimal MIME entity, so mailparser converts it like a whole mail. */
function entity(part: TextPart): Buffer {
  const header = `Content-Type: ${part.type}; charset="${part.charset ?? 'utf-8'}"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, 'utf8'), part.content]);
}

async function renderPart(part: TextPart, format: 'plain' | 'html'): Promise<string> {
  const parsed = await simpleParser(entity(part));
  if (format === 'plain') return parsed.text ?? '';
  return typeof parsed.html === 'string' ? parsed.html : (parsed.textAsHtml ?? '');
}

export async function renderText(
  parts: readonly TextPart[],
  format: 'plain' | 'html',
): Promise<string> {
  const rendered: string[] = [];
  for (const part of parts) rendered.push(await renderPart(part, format));
  const body = rendered.join('\n');
  const cut = parts.some((part) => part.cut);
  if (body.length > MAX_BODY_CHARS) return `${body.slice(0, MAX_BODY_CHARS)}\n[truncated]`;
  return cut ? `${body}\n[truncated]` : body;
}
