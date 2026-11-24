import * as z from 'zod';
import { assertLevel, levelAllows } from '../config/levels.js';
import type { AccessLevel, Account } from '../config/types.js';
import { MailError } from '../errors.js';
import { decodeMessageId, decodeThreadId } from '../ids.js';
import type { LogTarget } from '../log.js';
import type { MailWriter } from '../mail/write-types.js';
import type { ToolDeps } from './read-tools.js';

export interface ToolScope {
  accounts: readonly Account[];
  /** Set on /mcp/<id>: the account parameter disappears and ids must belong to it. */
  scopedAccountId: string | undefined;
}

export function accountIdSchema(accounts: readonly Account[]) {
  const [first, ...rest] = accounts.map((a) => a.id);
  if (first === undefined) throw new Error('at least one account is required');
  return z.enum([first, ...rest]).describe('Account id from list_accounts.');
}

/** The accounts of the scope whose level allows `need` (D15). */
export function accountsAllowing(scope: ToolScope, need: AccessLevel): Account[] {
  return scope.accounts.filter((a) => levelAllows(a.level, need));
}

export const NO_TARGET: LogTarget = { account: null, id: null };

/** Log label of a message id: its account and the opaque id; nothing for an invalid id. */
export function messageTarget(messageId: string): LogTarget {
  try {
    return { account: decodeMessageId(messageId).account, id: messageId };
  } catch {
    return NO_TARGET;
  }
}

/** Log label of a thread id; a references thread id embeds a Message-ID header, so only its account. */
export function threadTarget(threadId: string): LogTarget {
  try {
    const ref = decodeThreadId(threadId);
    return { account: ref.account, id: ref.kind === 'gmail' ? threadId : null };
  } catch {
    return NO_TARGET;
  }
}

export interface ScopeHelpers {
  /** The scope's account with this id; unknown_account if the endpoint does not offer it. */
  readonly inScope: (accountId: string) => Account;
  /** The account a single-account call targets, or null if none was given; never throws, so it is safe as a log label. */
  readonly requestedAccount: (requested: string | undefined) => string | null;
  /** The account a single-account call targets; unknown_account if none was given. */
  readonly onlyAccount: (requested: string | undefined) => string;
}

export function scopeHelpers(scope: ToolScope): ScopeHelpers {
  const requestedAccount = (requested: string | undefined): string | null =>
    scope.scopedAccountId ?? requested ?? null;
  return {
    inScope: (accountId) => {
      const found = scope.accounts.find((a) => a.id === accountId);
      if (found === undefined) {
        throw new MailError(
          'unknown_account',
          `Account "${accountId}" is not available on this endpoint.`,
        );
      }
      return found;
    },
    requestedAccount,
    onlyAccount: (requested) => {
      const id = requestedAccount(requested);
      if (id === null) throw new MailError('unknown_account', 'The account parameter is required.');
      return id;
    },
  };
}

/**
 * The writer of an account for a tool that needs `need`: the endpoint scope first (unknown_account),
 * then the level (not_permitted), then the writer.
 */
export function levelWriter(
  scope: ToolScope,
  deps: ToolDeps,
  need: AccessLevel,
): (accountId: string) => MailWriter {
  const { inScope } = scopeHelpers(scope);
  return (accountId) => {
    const account = inScope(accountId);
    assertLevel(account, need);
    return deps.writerFor(account.id);
  };
}
