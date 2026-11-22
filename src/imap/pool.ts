import type { Account } from '../config/types.js';
import { MailError } from '../errors.js';
import { errorClass, stderrConnectionLogger, type ConnectionLogger } from '../log.js';
import type { ImapClient, ImapClientFactory } from './client.js';

class PoolEntry {
  active = 0;
  broken = false;
  timer: NodeJS.Timeout | undefined;
  readonly client: Promise<ImapClient>;

  constructor(connect: ImapClientFactory, account: Account, logError: ConnectionLogger) {
    this.client = this.#open(connect, account, logError);
  }

  async #open(
    connect: ImapClientFactory,
    account: Account,
    logError: ConnectionLogger,
  ): Promise<ImapClient> {
    try {
      const client = await connect(account);
      client.on('close', () => {
        this.broken = true;
      });
      // Required: an unhandled 'error' event would crash the process. Only the error's class is
      // logged (its message may carry server text), once per connection; the next use reconnects.
      let errorLogged = false;
      client.on('error', (err) => {
        this.broken = true;
        if (errorLogged) return;
        errorLogged = true;
        logError({ event: 'connection_error', account: account.id, error: errorClass(err) });
      });
      return client;
    } catch (err) {
      this.broken = true;
      const reason = err instanceof Error ? err.message : String(err);
      throw new MailError(
        'connection_failed',
        `IMAP connection to ${account.imap.host} failed for account "${account.id}": ${reason}`,
        { cause: err },
      );
    }
  }
}

/** One IMAP connection per account, opened on demand and closed after idleMs without use. */
export class ImapPool {
  readonly #entries = new Map<string, PoolEntry>();

  constructor(
    private readonly connect: ImapClientFactory,
    private readonly idleMs = 60_000,
    private readonly logError: ConnectionLogger = stderrConnectionLogger,
  ) {}

  async use<T>(account: Account, fn: (client: ImapClient) => Promise<T>): Promise<T> {
    const entry = this.#acquire(account);
    try {
      const client = await entry.client;
      try {
        return await fn(client);
      } finally {
        if (!client.usable) entry.broken = true;
      }
    } finally {
      this.#release(account.id, entry);
    }
  }

  async closeAll(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(
      entries.map(async (entry) => {
        clearTimeout(entry.timer);
        await logoutEntry(entry);
      }),
    );
  }

  #acquire(account: Account): PoolEntry {
    const existing = this.#entries.get(account.id);
    if (existing !== undefined && !existing.broken) {
      clearTimeout(existing.timer);
      existing.timer = undefined;
      existing.active += 1;
      return existing;
    }
    const entry = new PoolEntry(this.connect, account, this.logError);
    entry.active = 1;
    this.#entries.set(account.id, entry);
    return entry;
  }

  #release(accountId: string, entry: PoolEntry): void {
    entry.active -= 1;
    if (entry.active > 0) return;
    if (entry.broken) {
      if (this.#entries.get(accountId) === entry) this.#entries.delete(accountId);
      return;
    }
    entry.timer = setTimeout(() => {
      if (entry.active > 0) return;
      if (this.#entries.get(accountId) === entry) this.#entries.delete(accountId);
      void logoutEntry(entry);
    }, this.idleMs);
    entry.timer.unref();
  }
}

async function logoutEntry(entry: PoolEntry): Promise<void> {
  try {
    const client = await entry.client;
    await client.logout();
  } catch {
    // Already closed or never connected: nothing to release.
  }
}
