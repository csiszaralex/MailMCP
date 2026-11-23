import type { SearchObject } from 'imapflow';
import type { Account } from '../config/types.js';
import { MailError } from '../errors.js';
import type { ThreadRef } from '../ids.js';
import type { ImapClient } from '../imap/client.js';
import { resolveMailbox } from '../imap/mailboxes.js';

/**
 * Where a thread's messages live and how to find them there. Gmail: the All Mail folder and
 * X-GM-THRID; others: the ref's mailbox and a Message-ID/References match on the thread root.
 * `mailbox` overrides the folder (restoring from Trash or Spam).
 */
export async function threadLocation(
  client: ImapClient,
  account: Account,
  ref: ThreadRef,
  mailbox?: string,
): Promise<{ path: string; criteria: SearchObject }> {
  if (ref.kind === 'gmail') {
    const path =
      mailbox ??
      (await resolveMailbox(client, { kind: 'special', use: '\\All' }, account.mailboxes));
    return { path, criteria: { threadId: ref.gmailThreadId } };
  }
  if (ref.rootMessageId === '') {
    throw new MailError(
      'not_found',
      'This message has no Message-ID header, so it has no thread; use get_message.',
    );
  }
  return {
    path: mailbox ?? ref.mailbox,
    criteria: {
      or: [
        { header: { 'message-id': ref.rootMessageId } },
        { header: { references: ref.rootMessageId } },
      ],
    },
  };
}
