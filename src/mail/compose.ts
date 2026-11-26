import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { Account } from '../config/types.js';
import { MailError } from '../errors.js';
import type { Address } from './types.js';
import type { OutgoingAttachment } from './write-types.js';

/** Total decoded size of one outgoing message's attachments (D14). */
export const OUTGOING_ATTACHMENTS_LIMIT_BYTES = 10 * 1024 * 1024;

export interface MimeAttachment {
  content: Buffer;
  filename: string | undefined;
  contentType: string;
  cid: string | undefined;
}

export interface MimeSpec {
  from: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text: string | undefined;
  html: string | undefined;
  attachments: MimeAttachment[];
  inReplyTo: string | undefined;
  references: string[];
  messageId: string;
  date: Date;
}

export interface QuotedOriginal {
  from: Address[];
  date: string | null;
  subject: string;
  to: Address[];
  text: string;
  html: string | undefined;
}

/** Decodes base64 attachments; an inline one gets the Content-ID `att<index>` (index over the whole list, D13). */
export function decodeAttachments(list: OutgoingAttachment[]): MimeAttachment[] {
  return list.map((item, index) => ({
    content: Buffer.from(item.content, 'base64'),
    filename: item.filename,
    contentType: item.mimeType ?? 'application/octet-stream',
    cid: item.inline ? `att${String(index)}` : undefined,
  }));
}

export function assertAttachmentBudget(attachments: readonly MimeAttachment[]): void {
  const total = attachments.reduce((sum, a) => sum + a.content.length, 0);
  if (total > OUTGOING_ATTACHMENTS_LIMIT_BYTES) {
    throw new MailError(
      'too_large',
      `Attachments total ${String(total)} bytes; the limit is ${String(OUTGOING_ATTACHMENTS_LIMIT_BYTES)} bytes.`,
    );
  }
}

function formatAddress(a: Address): string {
  return a.name === '' ? a.address : `${a.name} <${a.address}>`;
}

/** Object form, so a display name is never re-parsed as address syntax (no recipient injection). */
function toMimeAddress(a: Address): { name: string; address: string } {
  return { name: a.name, address: a.address };
}

function formatAddresses(list: Address[]): string {
  return list.map(formatAddress).join(', ');
}

/** Builds the RFC 5322 message. Files and URLs are never read: attachments come in as buffers only. */
export async function buildMime(spec: MimeSpec, options: { keepBcc: boolean }): Promise<Buffer> {
  assertAttachmentBudget(spec.attachments);
  const text = spec.text === undefined && spec.html === undefined ? '' : spec.text;
  const composer = new MailComposer({
    disableFileAccess: true,
    disableUrlAccess: true,
    from: spec.from,
    to: spec.to.map(toMimeAddress),
    cc: spec.cc.map(toMimeAddress),
    bcc: spec.bcc.map(toMimeAddress),
    subject: spec.subject,
    text,
    html: spec.html,
    attachments: spec.attachments.map((a) => ({
      content: a.content,
      filename: a.filename,
      contentType: a.contentType,
      cid: a.cid,
    })),
    inReplyTo: spec.inReplyTo,
    references: spec.references,
    messageId: spec.messageId,
    date: spec.date,
  });
  const node = composer.compile();
  node.keepBcc = options.keepBcc;
  return node.build();
}

export function newMessageId(account: Account): string {
  const domain = account.address.slice(account.address.lastIndexOf('@') + 1);
  return `<${randomUUID()}@${domain}>`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function textToHtml(text: string): string {
  return escapeHtml(text).replaceAll(/\r?\n/g, '<br>');
}

export function withSignature(
  text: string | undefined,
  html: string | undefined,
  signature: string | undefined,
): { text: string | undefined; html: string | undefined } {
  if (signature === undefined) return { text, html };
  return {
    text: text === undefined ? undefined : `${text}\n\n-- \n${signature}`,
    html: html === undefined ? undefined : `${html}<br><br>-- <br>${textToHtml(signature)}`,
  };
}

export function quoteReply(
  original: QuotedOriginal,
  text: string | undefined,
  html: string | undefined,
): { text: string | undefined; html: string | undefined } {
  const attribution = `On ${original.date ?? 'an unknown date'}, ${formatAddresses(original.from)} wrote:`;
  const quotedText = original.text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
  const quotedHtml = original.html ?? textToHtml(original.text);
  return {
    text: text === undefined ? undefined : `${text}\n\n${attribution}\n${quotedText}`,
    html:
      html === undefined
        ? undefined
        : `${html}<br><br>${escapeHtml(attribution)}<br><blockquote>${quotedHtml}</blockquote>`,
  };
}

export function forwardBody(
  original: QuotedOriginal,
  text: string | undefined,
  html: string | undefined,
): { text: string; html: string | undefined } {
  const header = [
    '---------- Forwarded message ---------',
    `From: ${formatAddresses(original.from)}`,
    `Date: ${original.date ?? ''}`,
    `Subject: ${original.subject}`,
    `To: ${formatAddresses(original.to)}`,
  ];
  const block = `${header.join('\n')}\n\n${original.text}`;
  const outText = text === undefined || text === '' ? block : `${text}\n\n${block}`;
  if (html === undefined && original.html === undefined) return { text: outText, html: undefined };
  const htmlHeader = header.map(escapeHtml).join('<br>');
  const originalHtml = original.html ?? textToHtml(original.text);
  const own = html ?? (text === undefined ? '' : textToHtml(text));
  return {
    text: outText,
    html: `${own}<br><br>${htmlHeader}<br><br>${originalHtml}`,
  };
}

export function prefixSubject(prefix: 'Re:' | 'Fwd:', subject: string): string {
  return subject.toLowerCase().startsWith(prefix.toLowerCase()) ? subject : `${prefix} ${subject}`;
}
