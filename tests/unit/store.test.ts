import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Store, type GrantRow } from '../../src/store/store.js';

const MINUTE = 60_000;

const GRANT: Omit<GrantRow, 'revokedAt'> = {
  id: 'grant-a',
  clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
  resource: 'http://127.0.0.1:8787/mcp/work',
  scope: 'mail',
  createdAt: 1_000,
  lastUsedAt: 1_000,
};

const open: Store[] = [];

function memory(): Store {
  const store = Store.open(':memory:');
  open.push(store);
  return store;
}

afterEach(() => {
  for (const store of open.splice(0)) store.close();
});

describe('Store grants', () => {
  it('inserts and lists grants, newest first', () => {
    const store = memory();
    store.insertGrant(GRANT);
    store.insertGrant({ ...GRANT, id: 'grant-b', createdAt: 2_000, lastUsedAt: 2_000 });
    const grants = store.listGrants();
    expect(grants.map((g) => g.id)).toEqual(['grant-b', 'grant-a']);
    expect(grants[1]).toEqual({ ...GRANT, revokedAt: null });
  });

  it('touches a grant', () => {
    const store = memory();
    store.insertGrant(GRANT);
    store.touchGrant('grant-a', 5_000);
    expect(store.listGrants()[0]?.lastUsedAt).toBe(5_000);
  });

  it('revokes a grant only once', () => {
    const store = memory();
    store.insertGrant(GRANT);
    expect(store.revokeGrant('grant-a', 7_000)).toBe(true);
    expect(store.revokeGrant('grant-a', 8_000)).toBe(false);
    expect(store.listGrants()[0]?.revokedAt).toBe(7_000);
  });

  it('finds a grant by id', () => {
    const store = memory();
    store.insertGrant(GRANT);
    store.revokeGrant('grant-a', 7_000);
    expect(store.findGrant('grant-a')).toEqual({ ...GRANT, revokedAt: 7_000 });
    expect(store.findGrant('missing')).toBeUndefined();
  });

  it('does not revoke an unknown grant', () => {
    expect(memory().revokeGrant('missing', 1)).toBe(false);
  });
});

describe('Store tokens', () => {
  it('finds a token together with its grant', () => {
    const store = memory();
    store.insertGrant(GRANT);
    store.insertToken({ hash: 'h1', grantId: 'grant-a', kind: 'access', expiresAt: 9_000 });
    expect(store.findToken('h1')).toEqual({
      hash: 'h1',
      grantId: 'grant-a',
      kind: 'access',
      expiresAt: 9_000,
      usedAt: null,
      grant: { ...GRANT, revokedAt: null },
    });
    expect(store.findToken('h2')).toBeUndefined();
  });

  it('rejects a token for an unknown grant', () => {
    const store = memory();
    expect(() => {
      store.insertToken({ hash: 'h1', grantId: 'missing', kind: 'refresh', expiresAt: 9_000 });
    }).toThrow(/FOREIGN KEY/);
  });

  it('marks a token used only for the first caller', () => {
    const store = memory();
    store.insertGrant(GRANT);
    store.insertToken({ hash: 'h1', grantId: 'grant-a', kind: 'refresh', expiresAt: 9_000 });
    expect(store.markTokenUsed('h1', 3_000)).toBe(true);
    expect(store.markTokenUsed('h1', 4_000)).toBe(false);
    expect(store.findToken('h1')?.usedAt).toBe(3_000);
    expect(store.markTokenUsed('missing', 4_000)).toBe(false);
  });

  it('prunes only the expired tokens', () => {
    const store = memory();
    store.insertGrant(GRANT);
    store.insertToken({ hash: 'old', grantId: 'grant-a', kind: 'access', expiresAt: 4_999 });
    store.insertToken({ hash: 'edge', grantId: 'grant-a', kind: 'access', expiresAt: 5_000 });
    store.insertToken({ hash: 'new', grantId: 'grant-a', kind: 'refresh', expiresAt: 6_000 });
    store.pruneTokens(5_000);
    expect(store.findToken('old')).toBeUndefined();
    expect(store.findToken('edge')).toBeDefined();
    expect(store.findToken('new')).toBeDefined();
  });
});

describe('Store login failures', () => {
  it('counts failures per ip and in total since a time', () => {
    const store = memory();
    store.recordLoginFailure('1.1.1.1', 10 * MINUTE);
    store.recordLoginFailure('1.1.1.1', 11 * MINUTE);
    store.recordLoginFailure('2.2.2.2', 12 * MINUTE);
    expect(store.countLoginFailures(0, '1.1.1.1')).toBe(2);
    expect(store.countLoginFailures(0, '2.2.2.2')).toBe(1);
    expect(store.countLoginFailures(0)).toBe(3);
    expect(store.countLoginFailures(11 * MINUTE, '1.1.1.1')).toBe(1);
    expect(store.countLoginFailures(11 * MINUTE)).toBe(2);
    expect(store.countLoginFailures(0, '3.3.3.3')).toBe(0);
  });

  it('finds the oldest failure of an ip since a time', () => {
    const store = memory();
    store.recordLoginFailure('1.1.1.1', 10 * MINUTE);
    store.recordLoginFailure('1.1.1.1', 12 * MINUTE);
    store.recordLoginFailure('2.2.2.2', 5 * MINUTE);
    expect(store.oldestLoginFailure(0, '1.1.1.1')).toBe(10 * MINUTE);
    expect(store.oldestLoginFailure(11 * MINUTE, '1.1.1.1')).toBe(12 * MINUTE);
    expect(store.oldestLoginFailure(13 * MINUTE, '1.1.1.1')).toBeUndefined();
    expect(store.oldestLoginFailure(0, '3.3.3.3')).toBeUndefined();
  });

  it('clears the failures of one ip only', () => {
    const store = memory();
    store.recordLoginFailure('1.1.1.1', 10 * MINUTE);
    store.recordLoginFailure('2.2.2.2', 10 * MINUTE);
    store.clearLoginFailures('1.1.1.1');
    expect(store.countLoginFailures(0, '1.1.1.1')).toBe(0);
    expect(store.countLoginFailures(0, '2.2.2.2')).toBe(1);
  });

  it('deletes failures older than 15 minutes when recording', () => {
    const store = memory();
    store.recordLoginFailure('1.1.1.1', 0);
    store.recordLoginFailure('1.1.1.1', 1);
    store.recordLoginFailure('2.2.2.2', 15 * MINUTE + 1);
    expect(store.countLoginFailures(0)).toBe(2);
  });
});

describe('Store TOTP steps', () => {
  it('claims a step only once', () => {
    const store = memory();
    expect(store.claimTotpStep(100, 3_000)).toBe(true);
    expect(store.claimTotpStep(100, 4_000)).toBe(false);
    expect(store.claimTotpStep(101, 4_000)).toBe(true);
  });

  it('refuses a step older than the newest claimed one', () => {
    const store = memory();
    expect(store.claimTotpStep(101, 3_000)).toBe(true);
    // The previous step's code is still inside the ±1 tolerance, but a newer one was used.
    expect(store.claimTotpStep(100, 4_000)).toBe(false);
    expect(store.claimTotpStep(102, 4_000)).toBe(true);
    expect(store.claimTotpStep(101, 4_000)).toBe(false);
  });

  it('forgets steps older than 15 minutes', () => {
    const store = memory();
    expect(store.claimTotpStep(100, 0)).toBe(true);
    expect(store.claimTotpStep(100, 15 * MINUTE)).toBe(false);
    expect(store.claimTotpStep(100, 15 * MINUTE + 1)).toBe(true);
  });
});

describe('Store file', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('keeps the grants across reopening and creates the parent directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'mailmcp-store-'));
    const path = join(dir, 'nested', 'mailmcp.sqlite');
    const first = Store.open(path);
    first.insertGrant(GRANT);
    first.close();

    const second = Store.open(path);
    try {
      expect(second.listGrants()).toEqual([{ ...GRANT, revokedAt: null }]);
      second.insertGrant({ ...GRANT, id: 'grant-b' });
      expect(second.listGrants()).toHaveLength(2);
    } finally {
      second.close();
    }

    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
      expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    } finally {
      raw.close();
    }
  });

  it('refuses a database written by a newer version', () => {
    dir = mkdtempSync(join(tmpdir(), 'mailmcp-store-'));
    const path = join(dir, 'mailmcp.sqlite');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 2');
    db.close();
    expect(() => Store.open(path)).toThrow(/newer version/);
  });
});
