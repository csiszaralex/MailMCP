import { simpleParser, type AddressObject, type EmailAddress } from 'mailparser';
import { MailError } from '../errors.js';
import type { MessageRef } from '../ids.js';
import type { ImapClient } from '../imap/client.js';
import { OUTGOING_ATTACHMENTS_LIMIT_BYTES, type MimeAttachment } from './compose.js';
import { messageGone } from './ref-checks.js';
import type { Address } from './types.js';

/** Largest stored message read back: the attachment limit in base64 (4/3) plus 1 MiB for the body. */
export const STORED_MESSAGE_LIMIT_BYTES =
  Math.ceil((OUTGOING_ATTACHMENTS_LIMIT_BYTES * 4) / 3) + 1024 * 1024;

/** A stored message (a draft) parsed back into the fields a new version is built from. */
export interface StoredMessage {
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text: string | undefined;
  html: string | undefined;
  attachments: MimeAttachment[];
  inReplyTo: string | undefined;
  references: string[];
}

function flatten(list: EmailAddress[]): Address[] {
  return list.flatMap((entry) => {
    if (entry.group !== undefined) return flatten(entry.group);
    return entry.address === undefined || entry.address === ''
      ? []
      : [{ name: entry.name, address: entry.address }];
  });
}

function addresses(value: AddressObject | AddressObject[] | undefined): Address[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((object) => flatten(object.value));
}

function tooLarge(): MailError {
  return new MailError(
    'too_large',
    `The stored message is larger than ${String(STORED_MESSAGE_LIMIT_BYTES)} bytes.`,
  );
}

/**
 * Downloads and parses one message of the mailbox the caller has locked. The server's size is
 * checked before the download, so an oversized message is never fetched.
 */
export async function readStored(client: ImapClient, ref: MessageRef): Promise<StoredMessage> {
  const meta = await client.fetchOne(String(ref.uid), { uid: true, size: true }, { uid: true });
  if (meta === false) throw messageGone();
  if ((meta.size ?? 0) > STORED_MESSAGE_LIMIT_BYTES) throw tooLarge();
  const full = await client.fetchOne(
    String(ref.uid),
    { uid: true, source: { maxLength: STORED_MESSAGE_LIMIT_BYTES + 1 } },
    { uid: true },
  );
  if (full === false || full.source === undefined) throw messageGone();
  if (full.source.length > STORED_MESSAGE_LIMIT_BYTES) throw tooLarge();
  // keepCidLinks: the HTML must keep its cid: references to the inline attachments.
  const parsed = await simpleParser(full.source, { keepCidLinks: true, skipTextToHtml: true });
  const references = parsed.references ?? [];
  return {
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    bcc: addresses(parsed.bcc),
    subject: parsed.subject ?? '',
    text: parsed.text,
    html: typeof parsed.html === 'string' ? parsed.html : undefined,
    attachments: parsed.attachments.map((a) => ({
      content: a.content,
      filename: a.filename,
      contentType: a.contentType,
      cid: a.cid,
    })),
    inReplyTo: parsed.inReplyTo,
    references: Array.isArray(references) ? references : [references],
  };
}
