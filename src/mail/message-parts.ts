import type {
  FetchMessageObject,
  FetchQueryObject,
  MessageAddressObject,
  MessageStructureObject,
} from 'imapflow';
import type { Account } from '../config/types.js';
import { encodeThreadId } from '../ids.js';
import type { Address, AttachmentInfo } from './types.js';

export function toAddresses(list: MessageAddressObject[] | undefined): Address[] {
  return (list ?? []).flatMap((entry) =>
    entry.address === undefined || entry.address === ''
      ? []
      : [{ name: entry.name ?? '', address: entry.address }],
  );
}

function isoDate(value: Date | string | undefined): string | null {
  if (value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** For display: the sender's Date header, else the server's internal date. */
export function messageDate(msg: FetchMessageObject): string | null {
  return isoDate(msg.envelope?.date ?? msg.internalDate);
}

/** For ordering: the server's internal (receive) date, which the sender cannot set. */
export function receivedDate(msg: FetchMessageObject): string | null {
  return isoDate(msg.internalDate);
}

export function collectAttachments(
  structure: MessageStructureObject | undefined,
): AttachmentInfo[] {
  if (structure === undefined) return [];
  const filename = structure.dispositionParameters?.filename ?? structure.parameters?.name;
  // An attached mail is one attachment; its own parts belong to it, not to this message.
  if (structure.type === 'message/rfc822') {
    return [
      {
        attachmentId: structure.part ?? '1',
        filename: filename ?? 'message.eml',
        mimeType: structure.type,
        size: structure.size ?? 0,
      },
    ];
  }
  if (structure.childNodes !== undefined && structure.childNodes.length > 0) {
    return structure.childNodes.flatMap((child) => collectAttachments(child));
  }
  const isAttachment =
    structure.disposition === 'attachment' ||
    (filename !== undefined && !structure.type.startsWith('text/'));
  if (!isAttachment) return [];
  return [
    {
      attachmentId: structure.part ?? '1',
      filename: filename ?? 'attachment',
      mimeType: structure.type,
      size: structure.size ?? 0,
    },
  ];
}

/** The Message-IDs of a fetched References header (`headers: ['references']`), in order. */
export function referenceIds(headers: Buffer | undefined): string[] {
  const unfolded = headers?.toString('utf8').replace(/\r?\n[ \t]+/g, ' ') ?? '';
  const references = /^references:(.*)$/im.exec(unfolded)?.[1];
  return references === undefined ? [] : (references.match(/<[^<>\s]+>/g) ?? []);
}

/** The thread root for servers without X-GM-THRID: first References entry, else own Message-ID. */
export function threadRootId(
  headers: Buffer | undefined,
  ownMessageId: string | undefined,
): string | undefined {
  return referenceIds(headers)[0] ?? ownMessageId;
}

/** The fetch fields messageThreadId needs: X-GM-THRID on Gmail, else the envelope and References. */
export function threadIdFields(account: Account): FetchQueryObject {
  return account.provider === 'gmail'
    ? { threadId: true }
    : { envelope: true, headers: ['references'] };
}

/** The thread id of a message fetched with threadIdFields. */
export function messageThreadId(account: Account, path: string, msg: FetchMessageObject): string {
  if (account.provider === 'gmail' && msg.threadId !== undefined) {
    return encodeThreadId({ kind: 'gmail', account: account.id, gmailThreadId: msg.threadId });
  }
  return encodeThreadId({
    kind: 'references',
    account: account.id,
    mailbox: path,
    rootMessageId: threadRootId(msg.headers, msg.envelope?.messageId) ?? '',
  });
}

export type TextType = 'text/plain' | 'text/html';

export interface TextPartRef {
  /** IMAP body part number; "1" for a single-part message. */
  part: string;
  type: TextType;
}

function inlineTextLeaves(structure: MessageStructureObject): TextPartRef[] {
  if (structure.childNodes !== undefined && structure.childNodes.length > 0) {
    // An attached message/rfc822 has its own body: its text is not part of this mail's body.
    if (structure.type === 'message/rfc822') return [];
    return structure.childNodes.flatMap((child) => inlineTextLeaves(child));
  }
  if (structure.disposition === 'attachment') return [];
  if (structure.type !== 'text/plain' && structure.type !== 'text/html') return [];
  return [{ part: structure.part ?? '1', type: structure.type }];
}

/**
 * The body parts to download for a format: the parts of the preferred type, else those of
 * the other text type (mailparser then converts between html and text).
 */
export function textParts(
  structure: MessageStructureObject | undefined,
  format: 'plain' | 'html',
): TextPartRef[] {
  if (structure === undefined) return [];
  const leaves = inlineTextLeaves(structure);
  const preferred: TextType = format === 'plain' ? 'text/plain' : 'text/html';
  const own = leaves.filter((leaf) => leaf.type === preferred);
  return own.length > 0 ? own : leaves.filter((leaf) => leaf.type !== preferred);
}
