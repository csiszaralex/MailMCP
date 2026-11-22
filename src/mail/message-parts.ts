import type { FetchMessageObject, MessageAddressObject, MessageStructureObject } from 'imapflow';
import type { Address, AttachmentInfo } from './types.js';

export function toAddresses(list: MessageAddressObject[] | undefined): Address[] {
  return (list ?? []).flatMap((entry) =>
    entry.address === undefined || entry.address === ''
      ? []
      : [{ name: entry.name ?? '', address: entry.address }],
  );
}

export function messageDate(msg: FetchMessageObject): string | null {
  const value = msg.envelope?.date ?? msg.internalDate;
  if (value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function collectAttachments(
  structure: MessageStructureObject | undefined,
): AttachmentInfo[] {
  if (structure === undefined) return [];
  if (structure.childNodes !== undefined && structure.childNodes.length > 0) {
    return structure.childNodes.flatMap((child) => collectAttachments(child));
  }
  const filename = structure.dispositionParameters?.filename ?? structure.parameters?.name;
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

/** The thread root for servers without X-GM-THRID: first References entry, else own Message-ID. */
export function threadRootId(
  headers: Buffer | undefined,
  ownMessageId: string | undefined,
): string | undefined {
  const unfolded = headers?.toString('utf8').replace(/\r?\n[ \t]+/g, ' ') ?? '';
  const references = /^references:(.*)$/im.exec(unfolded)?.[1];
  const first = references === undefined ? undefined : /<[^<>\s]+>/.exec(references)?.[0];
  return first ?? ownMessageId;
}
