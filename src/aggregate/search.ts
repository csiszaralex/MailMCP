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

function newestFirst(a: MessageSummary, b: MessageSummary): number {
  return (b.date ?? '').localeCompare(a.date ?? '');
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
  const candidates: MessageSummary[] = [];
  settled.forEach((outcome, index) => {
    const id = providers[index]?.account.id ?? '';
    if (outcome.status === 'fulfilled') {
      totals.set(id, outcome.value.total);
      candidates.push(...outcome.value.messages);
    } else {
      const reason = outcome.reason instanceof MailError ? outcome.reason : undefined;
      errors.push({ account: id, ...clientError(reason) });
    }
  });

  const messages = candidates.sort(newestFirst).slice(0, pageSize);
  const next: Record<string, number> = {};
  for (const provider of providers) {
    const id = provider.account.id;
    next[id] = startOf(id) + messages.filter((m) => m.account === id).length;
  }
  const more = [...totals].some(([id, total]) => (next[id] ?? 0) < total);
  return { messages, nextPageToken: more ? encodeCursor(next) : null, errors };
}
