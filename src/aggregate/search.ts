import { clientError, MailError, type ClientErrorCode } from '../errors.js';
import { decodeCursor, encodeCursor } from '../ids.js';
import type { MailProvider, MessageSummary } from '../mail/types.js';

export interface AccountError {
  account: string;
  code: ClientErrorCode;
  /** Client-safe: a MailError message, otherwise the generic internal error text. */
  message: string;
}

export interface AggregateResult {
  messages: MessageSummary[];
  nextPageToken: string | null;
  errors: AccountError[];
}

function newer(a: MessageSummary, b: MessageSummary): boolean {
  return (a.date ?? '').localeCompare(b.date ?? '') > 0;
}

interface Lane {
  id: string;
  messages: MessageSummary[];
  taken: number;
}

/**
 * Head-to-head merge: always take the newest head among the accounts, never reorder
 * within an account. The part taken from each account is then a prefix of its page,
 * so advancing its offset by the count taken never skips or repeats a message.
 */
function mergeHeads(lanes: Lane[], pageSize: number): MessageSummary[] {
  const merged: MessageSummary[] = [];
  while (merged.length < pageSize) {
    let best: Lane | undefined;
    for (const lane of lanes) {
      const head = lane.messages[lane.taken];
      if (head === undefined) continue;
      const bestHead = best?.messages[best.taken];
      if (bestHead === undefined || newer(head, bestHead)) best = lane;
    }
    const next = best?.messages[best.taken];
    if (best === undefined || next === undefined) break;
    merged.push(next);
    best.taken += 1;
  }
  return merged;
}

export async function searchAccounts(
  providers: readonly MailProvider[],
  query: string,
  pageSize: number,
  pageToken: string | undefined,
): Promise<AggregateResult> {
  const offsets = pageToken === undefined ? {} : decodeCursor(pageToken);
  const startOf = (id: string): number => offsets[id] ?? 0;

  const settled = await Promise.allSettled(
    providers.map((p) => p.search(query, startOf(p.account.id), pageSize)),
  );

  const errors: AccountError[] = [];
  const totals = new Map<string, number>();
  const lanes: Lane[] = [];
  settled.forEach((outcome, index) => {
    const id = providers[index]?.account.id ?? '';
    if (outcome.status === 'fulfilled') {
      totals.set(id, outcome.value.total);
      lanes.push({ id, messages: outcome.value.messages, taken: 0 });
    } else {
      const reason = outcome.reason instanceof MailError ? outcome.reason : undefined;
      errors.push({ account: id, ...clientError(reason) });
    }
  });

  const messages = mergeHeads(lanes, pageSize);
  const next: Record<string, number> = {};
  for (const provider of providers) {
    const id = provider.account.id;
    next[id] = startOf(id) + (lanes.find((lane) => lane.id === id)?.taken ?? 0);
  }
  const more = [...totals].some(([id, total]) => (next[id] ?? 0) < total);
  return { messages, nextPageToken: more ? encodeCursor(next) : null, errors };
}
