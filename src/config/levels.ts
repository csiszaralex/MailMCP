import { MailError } from '../errors.js';
import type { AccessLevel } from './schema.js';
import type { Account } from './types.js';

const RANK: Record<AccessLevel, number> = { read: 0, draft: 1, send: 2 };

/** Levels are ordered read < draft < send: a higher level allows everything a lower one does. */
export function levelAllows(have: AccessLevel, need: AccessLevel): boolean {
  return RANK[have] >= RANK[need];
}

export function assertLevel(account: Account, need: AccessLevel): void {
  if (!levelAllows(account.level, need)) {
    throw new MailError(
      'not_permitted',
      `Account "${account.id}" has level ${account.level}; this tool needs ${need}.`,
    );
  }
}
