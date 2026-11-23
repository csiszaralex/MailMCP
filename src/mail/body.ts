import { simpleParser } from 'mailparser';
import { MailError } from '../errors.js';
import type { TextType } from './message-parts.js';

export const RAW_LIMIT_BYTES = 5 * 1024 * 1024;
/** Longest body a tool returns; get_thread returns up to THREAD_MESSAGE_LIMIT of them. */
export const MAX_BODY_CHARS = 100_000;
/**
 * Decoded bytes read from all text parts of one message together; the part that reaches it is
 * cut, later parts are not downloaded, and the body is marked truncated.
 */
export const BODY_TEXT_LIMIT_BYTES = 2 * 1024 * 1024;

/** One downloaded text part, transfer encoding already removed. */
export interface TextPart {
  type: TextType;
  charset: string | undefined;
  content: Buffer;
  /** The message's text budget (BODY_TEXT_LIMIT_BYTES) ran out in or before this part. */
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

export interface RenderedBody {
  body: string;
  /** The body was cut at MAX_BODY_CHARS or at BODY_TEXT_LIMIT_BYTES. */
  truncated: boolean;
}

export async function renderText(
  parts: readonly TextPart[],
  format: 'plain' | 'html',
): Promise<RenderedBody> {
  const rendered: string[] = [];
  for (const part of parts) rendered.push(await renderPart(part, format));
  const body = rendered.join('\n');
  if (body.length > MAX_BODY_CHARS) return { body: body.slice(0, MAX_BODY_CHARS), truncated: true };
  return { body, truncated: parts.some((part) => part.cut) };
}
