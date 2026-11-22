import { describe, expect, it } from 'vitest';
import { searchAccounts } from '../../src/aggregate/search.js';
import { INTERNAL_ERROR_MESSAGE, MailError } from '../../src/errors.js';
import { decodeCursor } from '../../src/ids.js';
import type { MailProvider, MessageSummary, SearchPage } from '../../src/mail/types.js';
import type { Account } from '../../src/config/types.js';

function summary(account: string, n: number, date: string | null): MessageSummary {
  return {
    id: `${account}-${String(n)}`,
    threadId: `t-${account}-${String(n)}`,
    account,
    mailbox: 'INBOX',
    date,
    from: [],
    to: [],
    cc: [],
    subject: `${account} ${String(n)}`,
    flags: [],
    labels: [],
  };
}

function provider(id: string, messages: MessageSummary[]): MailProvider {
  return {
    account: { id } as Account,
    search: (_q: string, offset: number, limit: number): Promise<SearchPage> =>
      Promise.resolve({ total: messages.length, messages: messages.slice(offset, offset + limit) }),
  } as Partial<MailProvider> as MailProvider;
}

function failing(id: string, error: Error): MailProvider {
  return {
    account: { id } as Account,
    search: () => Promise.reject(error),
  } as Partial<MailProvider> as MailProvider;
}

const A = provider('a', [
  summary('a', 1, '2026-11-20T00:00:00Z'),
  summary('a', 2, '2026-11-18T00:00:00Z'),
  summary('a', 3, '2026-11-10T00:00:00Z'),
]);
const B = provider('b', [summary('b', 1, '2026-11-19T00:00:00Z'), summary('b', 2, null)]);

describe('searchAccounts', () => {
  it('merges accounts newest first and pages without gaps or duplicates', async () => {
    const first = await searchAccounts([A, B], '', 2, undefined);
    expect(first.messages.map((m) => m.id)).toEqual(['a-1', 'b-1']);
    expect(first.nextPageToken).not.toBeNull();
    expect(decodeCursor(first.nextPageToken ?? '')).toEqual({ a: 1, b: 1 });

    const second = await searchAccounts([A, B], '', 2, first.nextPageToken ?? undefined);
    expect(second.messages.map((m) => m.id)).toEqual(['a-2', 'a-3']);

    const third = await searchAccounts([A, B], '', 2, second.nextPageToken ?? undefined);
    expect(third.messages.map((m) => m.id)).toEqual(['b-2']);
    expect(third.nextPageToken).toBeNull();
  });

  it('keeps each account in its own order, so paging never skips or repeats', async () => {
    // Provider order is not date order inside an account (late delivery, moved mail).
    const inverted = provider('a', [
      summary('a', 1, '2026-11-10T00:00:00Z'),
      summary('a', 2, '2026-11-20T00:00:00Z'),
      summary('a', 3, '2026-11-05T00:00:00Z'),
    ]);
    const other = provider('b', [
      summary('b', 1, '2026-11-15T00:00:00Z'),
      summary('b', 2, '2026-11-01T00:00:00Z'),
    ]);
    const seen: string[] = [];
    let token: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await searchAccounts([inverted, other], '', 2, token);
      seen.push(...result.messages.map((m) => m.id));
      if (result.nextPageToken === null) break;
      token = result.nextPageToken;
    }
    expect([...seen].sort()).toEqual(['a-1', 'a-2', 'a-3', 'b-1', 'b-2']);
  });

  it('reports a failing account and still returns the others', async () => {
    const result = await searchAccounts(
      [A, failing('c', new Error('IMAP connection failed'))],
      '',
      10,
      undefined,
    );
    expect(result.messages).toHaveLength(3);
    expect(result.errors).toEqual([
      { account: 'c', code: 'internal', message: INTERNAL_ERROR_MESSAGE },
    ]);
    expect(result.nextPageToken).toBeNull();
  });

  it('passes a MailError code and message through', async () => {
    const error = new MailError('unsupported_query', 'X is only supported on Gmail accounts');
    const result = await searchAccounts([A, failing('c', error)], '', 10, undefined);
    expect(result.errors).toEqual([
      { account: 'c', code: 'unsupported_query', message: 'X is only supported on Gmail accounts' },
    ]);
  });
});
