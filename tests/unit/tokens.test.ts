import { createHash } from 'node:crypto';
import { OAuthError, OAuthErrorCode, type AuthInfo } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  TokenGrantError,
  TokenService,
} from '../../src/auth/tokens.js';
import type { AuthEventRecord } from '../../src/log.js';
import { Store } from '../../src/store/store.js';

const CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata';
const OTHER_CLIENT_ID = 'https://claude.com/oauth/other-client-metadata';
const RESOURCE = 'http://127.0.0.1:8787/mcp/work';
const START = 1_800_000_000_000;

const open: Store[] = [];

afterEach(() => {
  for (const store of open.splice(0)) store.close();
});

function setup(): {
  store: Store;
  tokens: TokenService;
  records: AuthEventRecord[];
  setNow: (at: number) => void;
} {
  const store = Store.open(':memory:');
  open.push(store);
  let now = START;
  const records: AuthEventRecord[] = [];
  const tokens = new TokenService(
    store,
    () => now,
    (record) => records.push(record),
  );
  return {
    store,
    tokens,
    records,
    setNow: (at) => {
      now = at;
    },
  };
}

function grant(tokens: TokenService): string {
  return tokens.createGrant({
    clientId: CLIENT_ID,
    resource: RESOURCE,
    scope: 'mail offline_access',
  });
}

async function rejectsAsInvalidToken(promise: Promise<AuthInfo>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(OAuthError);
  await expect(promise).rejects.toMatchObject({ code: OAuthErrorCode.InvalidToken });
}

function grantError(fn: () => void): TokenGrantError {
  try {
    fn();
  } catch (err) {
    if (err instanceof TokenGrantError) return err;
    throw err;
  }
  throw new Error('Expected a TokenGrantError.');
}

describe('TokenService.issue and verifyAccessToken', () => {
  it('issues a pair that verifies with the client, resource, scopes and expiry', async () => {
    const { tokens, store, records } = setup();
    const id = grant(tokens);
    const response = tokens.issue(id);
    expect(response).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'mail offline_access',
    });
    expect(response.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.access_token).not.toBe(response.refresh_token);

    const info = await tokens.verifyAccessToken(response.access_token);
    expect(info).toEqual({
      token: response.access_token,
      clientId: CLIENT_ID,
      scopes: ['mail', 'offline_access'],
      expiresAt: Math.floor((START + ACCESS_TOKEN_TTL_MS) / 1000),
      resource: new URL(RESOURCE),
    });

    expect(store.listGrants()[0]).toMatchObject({ id, createdAt: START, lastUsedAt: START });
    expect(records).toEqual([
      { event: 'token_issued', client: 'claude.ai', resource: RESOURCE, ip: null, reason: null },
    ]);
  });

  it('rejects the access token once 3600 s have passed', async () => {
    const { tokens, setNow } = setup();
    const { access_token } = tokens.issue(grant(tokens));
    setNow(START + ACCESS_TOKEN_TTL_MS - 1);
    await expect(tokens.verifyAccessToken(access_token)).resolves.toMatchObject({
      clientId: CLIENT_ID,
    });
    setNow(START + ACCESS_TOKEN_TTL_MS);
    await rejectsAsInvalidToken(tokens.verifyAccessToken(access_token));
  });

  it('rejects a refresh token used as an access token', async () => {
    const { tokens } = setup();
    const { refresh_token } = tokens.issue(grant(tokens));
    await rejectsAsInvalidToken(tokens.verifyAccessToken(refresh_token));
  });

  it('rejects an unknown token with the fixed message', async () => {
    const { tokens } = setup();
    await expect(tokens.verifyAccessToken('not-a-token')).rejects.toThrow(
      'The access token is invalid or expired.',
    );
  });

  it('does not touch the grant when verifying', async () => {
    const { tokens, store, setNow } = setup();
    const { access_token } = tokens.issue(grant(tokens));
    setNow(START + 1000);
    await tokens.verifyAccessToken(access_token);
    expect(store.listGrants()[0]?.lastUsedAt).toBe(START);
  });

  it('refuses to issue for an unknown or revoked grant', () => {
    const { tokens } = setup();
    expect(grantError(() => tokens.issue('missing')).code).toBe('invalid_grant');
    const id = grant(tokens);
    tokens.revokeGrant(id);
    expect(grantError(() => tokens.issue(id)).code).toBe('invalid_grant');
  });
});

describe('TokenService.refresh', () => {
  it('rotates the pair and touches the grant', async () => {
    const { tokens, store, records, setNow } = setup();
    const id = grant(tokens);
    const first = tokens.issue(id);
    setNow(START + 5000);
    const second = tokens.refresh(first.refresh_token, CLIENT_ID);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token).not.toBe(first.access_token);
    expect(second).toMatchObject({ expires_in: 3600, scope: 'mail offline_access' });
    await expect(tokens.verifyAccessToken(second.access_token)).resolves.toMatchObject({
      expiresAt: Math.floor((START + 5000 + ACCESS_TOKEN_TTL_MS) / 1000),
    });
    expect(store.listGrants()[0]?.lastUsedAt).toBe(START + 5000);
    expect(records.map((r) => r.event)).toEqual(['token_issued', 'token_refreshed']);
    expect(records[1]).toEqual({
      event: 'token_refreshed',
      client: 'claude.ai',
      resource: RESOURCE,
      ip: null,
      reason: null,
    });
  });

  it('revokes the whole grant when a used refresh token comes back', async () => {
    const { tokens, store, records } = setup();
    const id = grant(tokens);
    const first = tokens.issue(id);
    const second = tokens.refresh(first.refresh_token, CLIENT_ID);

    expect(grantError(() => tokens.refresh(first.refresh_token, CLIENT_ID)).code).toBe(
      'invalid_grant',
    );
    await rejectsAsInvalidToken(tokens.verifyAccessToken(second.access_token));
    await rejectsAsInvalidToken(tokens.verifyAccessToken(first.access_token));
    expect(grantError(() => tokens.refresh(second.refresh_token, CLIENT_ID)).code).toBe(
      'invalid_grant',
    );
    expect(store.listGrants()[0]?.revokedAt).toBe(START);
    expect(records.filter((r) => r.event === 'refresh_reuse')).toEqual([
      { event: 'refresh_reuse', client: 'claude.ai', resource: RESOURCE, ip: null, reason: null },
    ]);
  });

  it('rejects another client without revoking the grant', async () => {
    const { tokens, store } = setup();
    const first = tokens.issue(grant(tokens));
    expect(grantError(() => tokens.refresh(first.refresh_token, OTHER_CLIENT_ID)).code).toBe(
      'invalid_grant',
    );
    expect(store.listGrants()[0]?.revokedAt).toBeNull();
    await expect(tokens.verifyAccessToken(first.access_token)).resolves.toMatchObject({
      clientId: CLIENT_ID,
    });
    // The rejected attempt did not consume the token: the right client can still use it.
    expect(tokens.refresh(first.refresh_token, CLIENT_ID).token_type).toBe('Bearer');
  });

  it('rejects a refresh token after 30 days without revoking the grant', () => {
    const { tokens, store, setNow } = setup();
    const first = tokens.issue(grant(tokens));
    setNow(START + REFRESH_TOKEN_TTL_MS);
    expect(grantError(() => tokens.refresh(first.refresh_token, CLIENT_ID)).code).toBe(
      'invalid_grant',
    );
    expect(store.listGrants()[0]?.revokedAt).toBeNull();
  });

  it('accepts a refresh token just before 30 days', () => {
    const { tokens, setNow } = setup();
    const first = tokens.issue(grant(tokens));
    setNow(START + REFRESH_TOKEN_TTL_MS - 1);
    expect(tokens.refresh(first.refresh_token, CLIENT_ID).token_type).toBe('Bearer');
  });

  it('rejects an access token or an unknown token as a refresh token', () => {
    const { tokens, store } = setup();
    const first = tokens.issue(grant(tokens));
    expect(grantError(() => tokens.refresh(first.access_token, CLIENT_ID)).code).toBe(
      'invalid_grant',
    );
    expect(grantError(() => tokens.refresh('not-a-token', CLIENT_ID)).code).toBe('invalid_grant');
    expect(store.listGrants()[0]?.revokedAt).toBeNull();
  });
});

describe('TokenService.revokeGrant', () => {
  it('invalidates both the access and the refresh token', async () => {
    const { tokens } = setup();
    const id = grant(tokens);
    const pair = tokens.issue(id);
    expect(tokens.revokeGrant(id)).toBe(true);
    expect(tokens.revokeGrant(id)).toBe(false);
    await rejectsAsInvalidToken(tokens.verifyAccessToken(pair.access_token));
    expect(grantError(() => tokens.refresh(pair.refresh_token, CLIENT_ID)).code).toBe(
      'invalid_grant',
    );
  });
});

describe('TokenService secrecy', () => {
  it('stores only the sha256 hex of a token', () => {
    const { tokens, store } = setup();
    const pair = tokens.issue(grant(tokens));
    expect(store.findToken(pair.access_token)).toBeUndefined();
    expect(store.findToken(pair.refresh_token)).toBeUndefined();
    const hash = createHash('sha256').update(pair.access_token).digest('hex');
    expect(store.findToken(hash)?.kind).toBe('access');
  });

  it('never puts a token or its hash in a log record or an error message', () => {
    const { tokens, records } = setup();
    const first = tokens.issue(grant(tokens));
    const second = tokens.refresh(first.refresh_token, CLIENT_ID);
    const messages = [
      grantError(() => tokens.refresh(second.access_token, CLIENT_ID)).message,
      grantError(() => tokens.refresh(first.refresh_token, CLIENT_ID)).message,
      grantError(() => tokens.refresh(second.refresh_token, CLIENT_ID)).message,
    ];
    const output = JSON.stringify(records) + messages.join('\n');
    for (const token of [
      first.access_token,
      first.refresh_token,
      second.access_token,
      second.refresh_token,
    ]) {
      expect(output).not.toContain(token);
      expect(output).not.toContain(createHash('sha256').update(token).digest('hex'));
    }
    expect(records.map((r) => r.event)).toEqual([
      'token_issued',
      'token_refreshed',
      'refresh_reuse',
    ]);
  });
});
