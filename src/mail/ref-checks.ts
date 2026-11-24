import type { Account } from '../config/types.js';
import { MailError } from '../errors.js';
import type { MessageRef } from '../ids.js';

/**
 * Second line of defense: the tool layer checks the same first, with the same code: scopeHelpers().inScope
 * (tools/scope.ts) for every id, and create_draft (tools/write-tools.ts) with this function for its reply id.
 */
export function assertOwnAccount(account: Account, accountId: string): void {
  if (accountId !== account.id) {
    throw new MailError(
      'unknown_account',
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
