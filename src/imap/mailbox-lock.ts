import { MailError } from '../errors.js';
import type { ImapClient } from './client.js';

/** `read` locks the mailbox with EXAMINE (read-only), `write` with SELECT. */
export type LockAccess = 'read' | 'write';

/**
 * Runs `fn` while holding the mailbox lock and hands it the mailbox's UIDVALIDITY.
 * `from` says where the path came from, so a missing mailbox gets the right hint.
 */
export async function withMailbox<T>(
  client: ImapClient,
  path: string,
  opts: { access: LockAccess; from: 'query' | 'id' },
  fn: (uidValidity: string) => Promise<T>,
): Promise<T> {
  let lock;
  try {
    lock = await client.getMailboxLock(
      path,
      opts.access === 'read' ? { readOnly: true } : undefined,
    );
  } catch (err) {
    // imapflow sets mailboxMissing when SELECT/EXAMINE failed and LIST does not show the path.
    if (err instanceof Error && 'mailboxMissing' in err && err.mailboxMissing === true) {
      if (opts.from === 'query') throw unknownMailbox(path, { cause: err });
      throw new MailError(
        'mailbox_not_found',
        `The mailbox "${path}" of this id no longer exists, so the id is outdated; search again.`,
        { cause: err },
      );
    }
    throw err;
  }
  try {
    const mailbox = client.mailbox;
    // Only after the connection dropped right after the lock: not a missing mailbox.
    if (mailbox === false) throw new Error('No mailbox is selected after the lock.');
    return await fn(mailbox.uidValidity.toString());
  } finally {
    lock.release();
  }
}

/** Fails with `unsupported_server` when the server lacks a capability the action depends on. */
export function requireCapability(
  client: ImapClient,
  capability: 'UIDPLUS' | 'X-GM-EXT-1',
  action: string,
): void {
  if (!client.capabilities.has(capability)) {
    throw new MailError(
      'unsupported_server',
      `The mail server does not support ${capability}, which ${action} needs.`,
    );
  }
}

/**
 * Fails with `unsupported_server` unless the server can move messages by UID (D17): with MOVE, or
 * without it with UIDPLUS, where imapflow's messageMove copies the messages and then removes only
 * them with UID EXPUNGE. Every move must therefore pass `{ uid: true }`; without UIDPLUS imapflow
 * would send a plain EXPUNGE, which removes every message marked deleted in the mailbox.
 */
export function requireMove(client: ImapClient, action: string): void {
  if (!client.capabilities.has('MOVE') && !client.capabilities.has('UIDPLUS')) {
    throw new MailError(
      'unsupported_server',
      `The mail server supports neither MOVE nor UIDPLUS, which ${action} needs.`,
    );
  }
}

/** A mailbox named by the caller (a query, a label or folder name) that the account lacks. */
export function unknownMailbox(path: string, options?: ErrorOptions): MailError {
  return new MailError(
    'mailbox_not_found',
    `Mailbox "${path}" does not exist on this account; use list_labels to see the mailboxes.`,
    options,
  );
}
