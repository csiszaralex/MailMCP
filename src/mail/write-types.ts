import type { Account } from '../config/types.js';
import type { MessageRef, ThreadRef } from '../ids.js';

export interface OutgoingAttachment {
  /** base64 */
  content: string;
  filename: string | undefined;
  mimeType: string | undefined;
  inline: boolean;
}

export interface Composition {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string | undefined;
  htmlBody: string | undefined;
  attachments: OutgoingAttachment[];
  includeSignature: boolean;
}

/** update_draft: omitted fields keep the draft's value; attachments are replaced, never merged (D16). */
export interface DraftPatch {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  attachments: OutgoingAttachment[];
}

export interface ReplyInput {
  body: string | undefined;
  htmlBody: string | undefined;
  attachments: OutgoingAttachment[];
  includeSignature: boolean;
  replyAll: boolean;
  /** Override the computed recipients when given. */
  to: string[] | undefined;
  cc: string[] | undefined;
  bcc: string[];
}

export interface ForwardInput {
  to: string[];
  cc: string[];
  bcc: string[];
  forwardText: string | undefined;
  htmlBody: string | undefined;
  attachments: OutgoingAttachment[];
  includeSignature: boolean;
}

export type WriteTarget = { kind: 'message'; ref: MessageRef } | { kind: 'thread'; ref: ThreadRef };

export interface LabelChange {
  add: string[];
  remove: string[];
}

export type LabelAction =
  | { action: 'create'; name: string }
  | { action: 'rename'; name: string; newName: string }
  | { action: 'delete'; name: string };

export interface DraftOutcome {
  draftId: string;
  threadId: string;
  warnings: string[];
}

export interface MoveOutcome {
  messageIds: string[];
  warnings: string[];
}

export interface SendOutcome {
  messageIdHeader: string;
  /** The addresses the message went to, so the caller sees where a computed reply went. */
  to: string[];
  cc: string[];
  bcc: string[];
  sentCopyId: string | null;
  warnings: string[];
}

export interface MailWriter {
  readonly account: Account;
  createDraft(c: Composition, replyTo: MessageRef | undefined): Promise<DraftOutcome>;
  updateDraft(ref: MessageRef, patch: DraftPatch): Promise<DraftOutcome>;
  deleteDraft(ref: MessageRef): Promise<MoveOutcome>;
  updateLabels(target: WriteTarget, change: LabelChange): Promise<MoveOutcome>;
  manageLabel(action: LabelAction): Promise<void>;
  trash(target: WriteTarget): Promise<MoveOutcome>;
  untrash(target: WriteTarget): Promise<MoveOutcome>;
  markSpam(target: WriteTarget): Promise<MoveOutcome>;
  unmarkSpam(target: WriteTarget): Promise<MoveOutcome>;
  send(c: Composition): Promise<SendOutcome>;
  sendDraft(ref: MessageRef): Promise<SendOutcome>;
  reply(ref: MessageRef, input: ReplyInput): Promise<SendOutcome>;
  forward(ref: MessageRef, input: ForwardInput): Promise<SendOutcome>;
}
