import type { Account } from '../config/types.js';
import type { MessageRef, ThreadRef } from '../ids.js';

export interface Address {
  name: string;
  address: string;
}

export interface MessageSummary {
  id: string;
  threadId: string;
  account: string;
  mailbox: string;
  /** ISO 8601, from the Date header or else the server's internal date. */
  date: string | null;
  /** ISO 8601 server internal date (when the mailbox received it); results are ordered by it. */
  receivedAt: string | null;
  from: Address[];
  to: Address[];
  cc: Address[];
  subject: string;
  flags: string[];
  /** Gmail labels (X-GM-LABELS); empty for other servers. */
  labels: string[];
}

export type BodyFormat = 'metadata' | 'plain' | 'html' | 'raw';

export interface AttachmentInfo {
  /** IMAP body part number, e.g. "2" or "1.2". */
  attachmentId: string;
  filename: string;
  mimeType: string;
  /** Encoded size on the server in bytes (base64 is about 4/3 of the file). */
  size: number;
}

export interface MessageDetail extends MessageSummary {
  /**
   * Where a reply goes (D19). From the IMAP envelope, which repeats From when the message has no
   * Reply-To header (RFC 3501).
   */
  replyTo: Address[];
  messageIdHeader: string | null;
  inReplyTo: string | null;
  attachments: AttachmentInfo[];
  format: BodyFormat;
  /** null for the metadata format. */
  body: string | null;
  /** The body was cut to a length limit; get the raw format for the whole message. */
  truncated: boolean;
}

export interface ThreadPage {
  /** In chronological order: the newest THREAD_MESSAGE_LIMIT messages of the thread. */
  messages: MessageDetail[];
  /** How many older messages of the thread were left out. */
  olderOmitted: number;
}

export interface SearchPage {
  total: number;
  messages: MessageSummary[];
}

export interface LabelInfo {
  name: string;
  specialUse: string | null;
}

export interface AttachmentContent {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface MailProvider {
  readonly account: Account;
  search(query: string, offset: number, limit: number): Promise<SearchPage>;
  getMessage(ref: MessageRef, format: BodyFormat): Promise<MessageDetail>;
  getThread(ref: ThreadRef, format: BodyFormat): Promise<ThreadPage>;
  downloadAttachment(ref: MessageRef, attachmentId: string): Promise<AttachmentContent>;
  listLabels(): Promise<LabelInfo[]>;
  listDrafts(offset: number, limit: number): Promise<SearchPage>;
}
