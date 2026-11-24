import { MailError } from '../errors.js';
import type { LabelChange } from './write-types.js';

// The D22 rules that turn an update_labels request into flag, label and move steps. Pure: the
// IMAP execution lives in ImapMailWriter.

/** folderDestination's answer for "removing INBOX": the account's Archive mailbox. */
export const ARCHIVE = Symbol('archive');

/** The label names that are IMAP flags on every account. */
const FLAG_LABELS = new Set(['UNREAD', 'STARRED']);

/** Gmail system labels by the connector's names, as X-GM-LABELS spells them. */
const GMAIL_SYSTEM_LABELS = new Map([
  ['INBOX', '\\Inbox'],
  ['IMPORTANT', '\\Important'],
]);

/** Flags or Gmail labels to add and to remove. */
export interface FlagChange {
  add: string[];
  remove: string[];
}

/** UNREAD is the absence of \Seen, so adding UNREAD removes the flag and the other way round. */
export function flagChange(change: LabelChange): FlagChange {
  const add: string[] = [];
  const remove: string[] = [];
  if (change.add.includes('STARRED')) add.push('\\Flagged');
  if (change.remove.includes('UNREAD')) add.push('\\Seen');
  if (change.remove.includes('STARRED')) remove.push('\\Flagged');
  if (change.add.includes('UNREAD')) remove.push('\\Seen');
  return { add, remove };
}

function withoutFlagLabels(names: string[]): string[] {
  return names.filter((name) => !FLAG_LABELS.has(name));
}

function unsupportedLabels(rule: string): MailError {
  return new MailError('unsupported_query', rule);
}

/** Gmail: every name but UNREAD and STARRED is a label; TRASH and SPAM have their own tools. */
export function gmailLabelChange(change: LabelChange): FlagChange {
  if ([...change.add, ...change.remove].some((name) => name === 'TRASH' || name === 'SPAM')) {
    throw unsupportedLabels('Use trash or mark_spam to move messages to the trash or spam.');
  }
  const labels = (names: string[]): string[] =>
    withoutFlagLabels(names).map((name) => GMAIL_SYSTEM_LABELS.get(name) ?? name);
  return { add: labels(change.add), remove: labels(change.remove) };
}

/**
 * Other accounts: where the change moves the messages of `path`. Adding a folder moves there,
 * removing INBOX archives (ARCHIVE), anything else is refused.
 */
export function folderDestination(
  change: LabelChange,
  path: string,
): string | typeof ARCHIVE | undefined {
  const added = withoutFlagLabels(change.add);
  const removed = withoutFlagLabels(change.remove);
  if (added.length > 1) {
    throw unsupportedLabels(
      'A message is in exactly one folder on this account: add at most one folder per call.',
    );
  }
  if (removed.some((name) => name !== 'INBOX')) {
    throw unsupportedLabels(
      'Only INBOX can be removed on this account (that archives the message); to move it to another folder, add that folder.',
    );
  }
  const [folder] = added;
  if (removed.length === 0) return folder;
  if (folder !== undefined) {
    throw unsupportedLabels(
      'Adding a folder already moves the message out of its folder; do not also remove INBOX.',
    );
  }
  if (path !== 'INBOX') {
    throw unsupportedLabels(
      `Removing INBOX archives a message from INBOX, but this message is in "${path}".`,
    );
  }
  return ARCHIVE;
}
