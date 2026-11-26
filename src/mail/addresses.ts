import type { Account } from '../config/types.js';
import type { Address } from './types.js';

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Canonical form for comparing mailboxes: lowercase, without the "+tag" part of the local part.
 * For Gmail accounts, gmail.com and googlemail.com addresses also lose the dots of the local
 * part and use the gmail.com domain. An address without "@" or with an empty local part is
 * compared as a whole, lowercased.
 */
export function addressKey(address: string, provider: Account['provider']): string {
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at <= 0) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (provider === 'gmail' && GMAIL_DOMAINS.has(domain)) {
    local = local.replaceAll('.', '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

export function isOwnAddress(account: Account, address: string): boolean {
  return addressKey(address, account.provider) === addressKey(account.address, account.provider);
}

export interface ReplySource {
  from: Address[];
  to: Address[];
  cc: Address[];
  replyTo: Address[];
}

/** Drops the account's own addresses and duplicates (first occurrence wins), skipping keys in `seen`. */
function pick(list: Address[], account: Account, seen: Set<string>): Address[] {
  const result: Address[] = [];
  for (const entry of list) {
    if (isOwnAddress(account, entry.address)) continue;
    const key = addressKey(entry.address, account.provider);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

/** Picks the recipients of a reply (decision D19). */
export function replyRecipients(
  source: ReplySource,
  account: Account,
  replyAll: boolean,
): { to: Address[]; cc: Address[] } {
  const fromOwn = source.from.some((a) => isOwnAddress(account, a.address));
  let toList: Address[];
  let ccList: Address[];
  if (fromOwn) {
    toList = source.to;
    ccList = replyAll ? source.cc : [];
  } else {
    toList = source.replyTo.length > 0 ? source.replyTo : source.from;
    ccList = replyAll ? [...source.to, ...source.cc] : [];
  }
  const seen = new Set<string>();
  const to = pick(toList, account, seen);
  const cc = pick(ccList, account, seen);
  return { to, cc };
}
