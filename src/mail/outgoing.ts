import type { Account } from '../config/types.js';
import { MailError } from '../errors.js';
import type { Envelope } from '../smtp/sender.js';
import { replyRecipients } from './addresses.js';
import {
  decodeAttachments,
  forwardBody,
  newMessageId,
  prefixSubject,
  quoteReply,
  withSignature,
  type MimeAttachment,
  type MimeSpec,
  type QuotedOriginal,
} from './compose.js';
import type { Address, MessageDetail } from './types.js';
import type { Composition, ForwardInput, ReplyInput } from './write-types.js';

// Composition of outgoing messages (send, reply, forward and reply drafts) without any I/O;
// ImapMailWriter fetches the originals and runs IMAP and SMTP.

/** What a reply (a reply draft, or reply()) takes from the original message (D19). */
export interface ReplyContext {
  quoted: QuotedOriginal;
  /** `Re:` plus the original subject. */
  subject: string;
  inReplyTo: string | undefined;
  references: string[];
  /** Never empty: without other recipients the reply goes to the account itself (D19). */
  to: Address[];
  cc: Address[];
}

/** The original's headers that MessageDetail does not carry. */
export interface ReplyHeaders {
  messageId: string | undefined;
  references: string[];
}

/** Tool input addresses are bare e-mail addresses (the tool schema validates them). */
export function plainAddresses(list: string[]): Address[] {
  return list.map((address) => ({ name: '', address }));
}

/**
 * The MIME spec of a message from this account: From is always the account's own address, also
 * for a stored draft whose From names someone else.
 */
export function accountSpec(
  account: Account,
  fields: Omit<MimeSpec, 'from' | 'messageId' | 'date'>,
): MimeSpec {
  return { ...fields, from: account.address, messageId: newMessageId(account), date: new Date() };
}

/** The original as a quote or a forwarded block shows it. */
export function quotedOriginal(
  original: MessageDetail,
  text: string | undefined,
  html: string | undefined,
): QuotedOriginal {
  return {
    from: original.from,
    date: original.date,
    subject: original.subject,
    to: original.to,
    text: text ?? '',
    html,
  };
}

export function replyContext(
  account: Account,
  original: MessageDetail,
  html: string | undefined,
  headers: ReplyHeaders,
  replyAll: boolean,
): ReplyContext {
  const recipients = replyRecipients(
    { from: original.from, to: original.to, cc: original.cc, replyTo: original.replyTo },
    account,
    replyAll,
  );
  const { messageId } = headers;
  return {
    quoted: quotedOriginal(original, original.body ?? undefined, html),
    subject: prefixSubject('Re:', original.subject),
    inReplyTo: messageId,
    references: messageId === undefined ? headers.references : [...headers.references, messageId],
    to: recipients.to.length > 0 ? recipients.to : [{ name: '', address: account.address }],
    cc: recipients.cc,
  };
}

/** The user's text with the signature when asked; a message without any body still gets it. */
export function signedBody(
  account: Account,
  body: string | undefined,
  htmlBody: string | undefined,
  includeSignature: boolean,
): { text: string | undefined; html: string | undefined } {
  const text = body === undefined && htmlBody === undefined ? '' : body;
  return withSignature(text, htmlBody, includeSignature ? account.signature : undefined);
}

/** The body of a reply: the signed text followed by the quoted original (D19). */
export function replyBody(
  account: Account,
  context: ReplyContext,
  body: string | undefined,
  htmlBody: string | undefined,
  includeSignature: boolean,
): { text: string | undefined; html: string | undefined } {
  const signed = signedBody(account, body, htmlBody, includeSignature);
  return quoteReply(context.quoted, signed.text, signed.html);
}

/** send(): a new message. */
export function sendSpec(account: Account, c: Composition): MimeSpec {
  const body = signedBody(account, c.body, c.htmlBody, c.includeSignature);
  return accountSpec(account, {
    to: plainAddresses(c.to),
    cc: plainAddresses(c.cc),
    bcc: plainAddresses(c.bcc),
    subject: c.subject,
    text: body.text,
    html: body.html,
    attachments: decodeAttachments(c.attachments),
    inReplyTo: undefined,
    references: [],
  });
}

/** reply(): given recipients override the computed ones (D19). */
export function replySpec(account: Account, context: ReplyContext, input: ReplyInput): MimeSpec {
  const body = replyBody(account, context, input.body, input.htmlBody, input.includeSignature);
  return accountSpec(account, {
    to: input.to === undefined ? context.to : plainAddresses(input.to),
    cc: input.cc === undefined ? context.cc : plainAddresses(input.cc),
    bcc: plainAddresses(input.bcc),
    subject: context.subject,
    text: body.text,
    html: body.html,
    attachments: decodeAttachments(input.attachments),
    inReplyTo: context.inReplyTo,
    references: context.references,
  });
}

/**
 * forward() (D21): the note, the forwarded block and the original's attachments next to the new
 * ones. buildMime holds them all to the attachment budget (D14). No threading headers.
 */
export function forwardSpec(
  account: Account,
  original: QuotedOriginal,
  originalAttachments: MimeAttachment[],
  input: ForwardInput,
): MimeSpec {
  const signed = signedBody(account, input.forwardText, input.htmlBody, input.includeSignature);
  const body = forwardBody(original, signed.text, signed.html);
  return accountSpec(account, {
    to: plainAddresses(input.to),
    cc: plainAddresses(input.cc),
    bcc: plainAddresses(input.bcc),
    subject: prefixSubject('Fwd:', original.subject),
    text: body.text,
    html: body.html,
    attachments: [...originalAttachments, ...decodeAttachments(input.attachments)],
    inReplyTo: undefined,
    references: [],
  });
}

/** Every To, Cc and Bcc address receives the message; the Bcc header never goes out (D18). */
export function envelopeFor(spec: MimeSpec): Envelope {
  const to = [...spec.to, ...spec.cc, ...spec.bcc].map((a) => a.address);
  if (to.length === 0) throw new MailError('send_failed', 'The message has no recipients.');
  return { from: spec.from, to };
}
