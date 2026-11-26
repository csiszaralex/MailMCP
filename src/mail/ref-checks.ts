import type { Account } from '../config/types.js';
import { MailError } from '../errors.js';
import type { MessageRef } from '../ids.js';

/**
 * The id must belong to `account`. The tools pick the provider or writer by the id's own account
 * (after scopeHelpers().inScope in tools/scope.ts), so here this is a second line of defense. The
 * tools also call it directly where a call names an account and an id that may belong to another:
 * send with draftId and create_draft with replyToMessageId. Such arguments conflict, hence
 * invalid_argument; an account the endpoint lacks stays unknown_account (inScope).
 */
export function assertOwnAccount(account: Account, accountId: string): void {
  if (accountId !== account.id) {
    throw new MailError(
      'invalid_argument',
      `This id belongs to account "${accountId}", not "${account.id}".`,
    );
  }
}

/** A message id names a UID under one UIDVALIDITY; after the server rebuilt the mailbox it is void. */
export function assertCurrent(ref: MessageRef, uidValidity: string): void {
  if (uidValidity !== ref.uidValidity) {
    throw new MailError(
      'stale_id',
      'This message id is outdated (the mailbox was rebuilt); search again.',
    );
  }
}

export function messageGone(): MailError {
  return new MailError('not_found', 'Message not found; it may have been moved or deleted.');
}
