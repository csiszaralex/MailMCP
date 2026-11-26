import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';

/** How long login failures and used TOTP steps are kept (D34). */
export const FAILURE_WINDOW_MS = 15 * 60_000;

/** The CLI opens the same file while the server runs, so a writer waits for the lock. */
const BUSY_TIMEOUT_MS = 5000;

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE tokens (
  hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX tokens_grant_id ON tokens (grant_id);
CREATE TABLE login_failures (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX login_failures_at ON login_failures (at);
CREATE INDEX login_failures_ip ON login_failures (ip, at);
CREATE TABLE totp_steps (
  step INTEGER PRIMARY KEY,
  at INTEGER NOT NULL
);
`;

export interface GrantRow {
  id: string;
  clientId: string;
  resource: string;
  scope: string;
  createdAt: number;
  lastUsedAt: number;
  revokedAt: number | null;
}

export type TokenKind = 'access' | 'refresh';

export interface TokenRow {
  hash: string;
  grantId: string;
  kind: TokenKind;
  expiresAt: number;
  usedAt: number | null;
  grant: GrantRow;
}

type Row = Record<string, SQLOutputValue>;

function field(row: Row, name: string): SQLOutputValue {
  const value = row[name];
  if (value === undefined) throw new Error(`Store row has no column ${name}.`);
  return value;
}

function text(row: Row, name: string): string {
  const value = field(row, name);
  if (typeof value !== 'string') throw new Error(`Store column ${name} is not text.`);
  return value;
}

function int(row: Row, name: string): number {
  const value = field(row, name);
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Store column ${name} is not an integer.`);
  }
  return value;
}

function intOrNull(row: Row, name: string): number | null {
  return field(row, name) === null ? null : int(row, name);
}

function tokenKind(row: Row, name: string): TokenKind {
  const value = text(row, name);
  if (value === 'access' || value === 'refresh') return value;
  throw new Error(`Store column ${name} is not a token kind.`);
}

/** Reads a grant whose columns may carry a prefix (the token join uses `g_`). */
function toGrant(row: Row, prefix = ''): GrantRow {
  return {
    id: text(row, `${prefix}id`),
    clientId: text(row, `${prefix}client_id`),
    resource: text(row, `${prefix}resource`),
    scope: text(row, `${prefix}scope`),
    createdAt: int(row, `${prefix}created_at`),
    lastUsedAt: int(row, `${prefix}last_used_at`),
    revokedAt: intOrNull(row, `${prefix}revoked_at`),
  };
}

function toToken(row: Row): TokenRow {
  return {
    hash: text(row, 'hash'),
    grantId: text(row, 'grant_id'),
    kind: tokenKind(row, 'kind'),
    expiresAt: int(row, 'expires_at'),
    usedAt: intOrNull(row, 'used_at'),
    grant: toGrant(row, 'g_'),
  };
}

function changedOne(result: { changes: number | bigint }): boolean {
  return Number(result.changes) === 1;
}

function migrate(db: DatabaseSync): void {
  // IMMEDIATE takes the write lock first, so the server and the CLI cannot both create the schema.
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('PRAGMA user_version').get();
    const version = row === undefined ? 0 : int(row, 'user_version');
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `The database was written by a newer version (schema ${String(version)}, supported ${String(SCHEMA_VERSION)}).`,
      );
    }
    if (version === 0) {
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** SQLite storage for grants, token hashes, login failures and used TOTP steps (D27). */
export class Store {
  private readonly db: DatabaseSync;
  private readonly insertGrantStmt: StatementSync;
  private readonly touchGrantStmt: StatementSync;
  private readonly revokeGrantStmt: StatementSync;
  private readonly listGrantsStmt: StatementSync;
  private readonly findGrantStmt: StatementSync;
  private readonly insertTokenStmt: StatementSync;
  private readonly findTokenStmt: StatementSync;
  private readonly markTokenUsedStmt: StatementSync;
  private readonly pruneTokensStmt: StatementSync;
  private readonly insertFailureStmt: StatementSync;
  private readonly pruneFailuresStmt: StatementSync;
  private readonly countFailuresStmt: StatementSync;
  private readonly countIpFailuresStmt: StatementSync;
  private readonly clearFailuresStmt: StatementSync;
  private readonly claimStepStmt: StatementSync;
  private readonly pruneStepsStmt: StatementSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
    this.insertGrantStmt = db.prepare(
      `INSERT INTO grants (id, client_id, resource, scope, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.touchGrantStmt = db.prepare('UPDATE grants SET last_used_at = ? WHERE id = ?');
    this.revokeGrantStmt = db.prepare(
      'UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    );
    this.listGrantsStmt = db.prepare('SELECT * FROM grants ORDER BY created_at DESC, rowid DESC');
    this.findGrantStmt = db.prepare('SELECT * FROM grants WHERE id = ?');
    this.insertTokenStmt = db.prepare(
      'INSERT INTO tokens (hash, grant_id, kind, expires_at) VALUES (?, ?, ?, ?)',
    );
    this.findTokenStmt = db.prepare(
      `SELECT t.hash, t.grant_id, t.kind, t.expires_at, t.used_at,
              g.id AS g_id, g.client_id AS g_client_id, g.resource AS g_resource,
              g.scope AS g_scope, g.created_at AS g_created_at,
              g.last_used_at AS g_last_used_at, g.revoked_at AS g_revoked_at
       FROM tokens t JOIN grants g ON g.id = t.grant_id
       WHERE t.hash = ?`,
    );
    this.markTokenUsedStmt = db.prepare(
      'UPDATE tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL',
    );
    this.pruneTokensStmt = db.prepare('DELETE FROM tokens WHERE expires_at < ?');
    this.insertFailureStmt = db.prepare('INSERT INTO login_failures (ip, at) VALUES (?, ?)');
    this.pruneFailuresStmt = db.prepare('DELETE FROM login_failures WHERE at < ?');
    this.countFailuresStmt = db.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE at >= ?');
    this.countIpFailuresStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND at >= ?',
    );
    this.clearFailuresStmt = db.prepare('DELETE FROM login_failures WHERE ip = ?');
    this.claimStepStmt = db.prepare('INSERT OR IGNORE INTO totp_steps (step, at) VALUES (?, ?)');
    this.pruneStepsStmt = db.prepare('DELETE FROM totp_steps WHERE at < ?');
  }

  /** Opens (and on first use creates) the database; ':memory:' gives a private in-memory one. */
  static open(path: string): Store {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
      // An in-memory database keeps journal_mode=memory; the pragma is harmless there.
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA foreign_keys = ON');
      migrate(db);
      return new Store(db);
    } catch (err) {
      db.close();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  insertGrant(grant: Omit<GrantRow, 'revokedAt'>): void {
    this.insertGrantStmt.run(
      grant.id,
      grant.clientId,
      grant.resource,
      grant.scope,
      grant.createdAt,
      grant.lastUsedAt,
    );
  }

  touchGrant(id: string, at: number): void {
    this.touchGrantStmt.run(at, id);
  }

  /** False if the grant is unknown or already revoked. */
  revokeGrant(id: string, at: number): boolean {
    return changedOne(this.revokeGrantStmt.run(at, id));
  }

  /** Newest first. */
  listGrants(): GrantRow[] {
    return this.listGrantsStmt.all().map((row) => toGrant(row));
  }

  findGrant(id: string): GrantRow | undefined {
    const row = this.findGrantStmt.get(id);
    return row === undefined ? undefined : toGrant(row);
  }

  insertToken(token: Omit<TokenRow, 'usedAt' | 'grant'>): void {
    this.insertTokenStmt.run(token.hash, token.grantId, token.kind, token.expiresAt);
  }

  findToken(hash: string): TokenRow | undefined {
    const row = this.findTokenStmt.get(hash);
    return row === undefined ? undefined : toToken(row);
  }

  /** True only for the first caller: the update matches only while used_at is still NULL. */
  markTokenUsed(hash: string, at: number): boolean {
    return changedOne(this.markTokenUsedStmt.run(at, hash));
  }

  /** Deletes the tokens that expired before `before`. */
  pruneTokens(before: number): void {
    this.pruneTokensStmt.run(before);
  }

  recordLoginFailure(ip: string, at: number): void {
    this.pruneFailuresStmt.run(at - FAILURE_WINDOW_MS);
    this.insertFailureStmt.run(ip, at);
  }

  /** Failures at or after `since`, for one ip or for all of them. */
  countLoginFailures(since: number, ip?: string): number {
    const row =
      ip === undefined
        ? this.countFailuresStmt.get(since)
        : this.countIpFailuresStmt.get(ip, since);
    if (row === undefined) throw new Error('Store count returned no row.');
    return int(row, 'n');
  }

  clearLoginFailures(ip: string): void {
    this.clearFailuresStmt.run(ip);
  }

  /** False if the step was used before (within the kept window). */
  claimTotpStep(step: number, at: number): boolean {
    this.pruneStepsStmt.run(at - FAILURE_WINDOW_MS);
    return changedOne(this.claimStepStmt.run(step, at));
  }
}
