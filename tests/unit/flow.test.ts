import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CimdResolver } from '../../src/auth/cimd.js';
import {
  AuthorizationFlow,
  type AuthorizationFlowDeps,
  MAX_STATE_BYTES,
  type AuthorizeParams,
  type CompleteResult,
  type RedeemParams,
  type StartResult,
} from '../../src/auth/flow.js';
import { LoginLimiter } from '../../src/auth/limiter.js';
import { hashPassword, parsePasswordHash } from '../../src/auth/password.js';
import { resourceUrls } from '../../src/auth/resources.js';
import { TokenGrantError, TokenService } from '../../src/auth/tokens.js';
import { totpAt } from '../../src/auth/totp.js';
import type { AuthEventRecord } from '../../src/log.js';
import { Store } from '../../src/store/store.js';

/** 15 seconds into a 30 second TOTP step, so a few seconds of test time stay in the same step. */
const START = 1_800_000_015_000;
const MINUTE = 60_000;
const STEP_MS = 30_000;

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = parsePasswordHash(hashPassword(PASSWORD));
const TOTP_SECRET = Buffer.from('12345678901234567890');
const IP = '203.0.113.7';

const PUBLIC_URL = new URL('http://127.0.0.1:8787');
const RESOURCE = 'http://127.0.0.1:8787/mcp/work';
const AGGREGATE = 'http://127.0.0.1:8787/mcp';
const ISS = 'http://127.0.0.1:8787';

const CLAUDE_CODE_ID = 'https://claude.ai/oauth/claude-code-client-metadata';
const CLAUDE_CODE_DOC = {
  client_id: CLAUDE_CODE_ID,
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};
/** A second, invented client whose redirect URI carries its own query. */
const WEB_ID = 'https://claude.com/oauth/web-client-metadata';
const WEB_REDIRECT = 'https://claude.com/api/callback?tenant=a%20b';
const WEB_DOC = {
  client_id: WEB_ID,
  redirect_uris: [WEB_REDIRECT],
  token_endpoint_auth_method: 'none',
};
const REDIRECT = 'http://127.0.0.1:53124/callback';

/** RFC 7636 appendix B verifier; the challenge is computed here, not copied. */
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

const open: Store[] = [];

afterEach(() => {
  for (const store of open.splice(0)) store.close();
});

interface Setup {
  flow: AuthorizationFlow;
  /** The deps of flow, for a second instance (a restarted server). */
  deps: AuthorizationFlowDeps;
  tokens: TokenService;
  records: AuthEventRecord[];
  now: () => number;
  advance: (ms: number) => void;
}

function setup(): Setup {
  const store = Store.open(':memory:');
  open.push(store);
  let now = START;
  const clock = (): number => now;
  const records: AuthEventRecord[] = [];
  const log = (record: AuthEventRecord): void => {
    records.push(record);
  };
  const docs = new Map<string, object>([
    [CLAUDE_CODE_ID, CLAUDE_CODE_DOC],
    [WEB_ID, WEB_DOC],
  ]);
  const fetchFn: typeof fetch = (input) => {
    const doc = typeof input === 'string' ? docs.get(input) : undefined;
    return Promise.resolve(
      doc === undefined
        ? new Response('not found', { status: 404 })
        : new Response(JSON.stringify(doc), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    );
  };
  const tokens = new TokenService(store, clock, log);
  const deps: AuthorizationFlowDeps = {
    publicUrl: PUBLIC_URL,
    resources: new Set(resourceUrls(PUBLIC_URL, ['work']).values()),
    cimd: new CimdResolver(fetchFn, clock),
    tokens,
    limiter: new LoginLimiter(store, clock),
    store,
    passwordHash: PASSWORD_HASH,
    totpSecret: TOTP_SECRET,
    clock,
    log,
  };
  return {
    flow: new AuthorizationFlow(deps),
    deps,
    tokens,
    records,
    now: clock,
    advance: (ms) => {
      now += ms;
    },
  };
}

/** Overrides where an undefined value leaves the parameter out. */
type Overrides<T> = { [K in keyof T]?: string | undefined };

function compact<T extends object>(values: Overrides<T>): Partial<Record<keyof T, string>> {
  const out: Partial<Record<keyof T, string>> = {};
  for (const key of Object.keys(values) as (keyof T)[]) {
    const value = values[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function authorizeParams(overrides: Overrides<AuthorizeParams> = {}): AuthorizeParams {
  return compact<AuthorizeParams>({
    response_type: 'code',
    client_id: CLAUDE_CODE_ID,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    scope: 'offline_access',
    state: 'state-1',
    ...overrides,
  });
}

function rightCode(at: number): string {
  return totpAt(TOTP_SECRET, Math.floor(at / STEP_MS));
}

function wrongCode(at: number): string {
  const right = rightCode(at);
  return right === '000000' ? '111111' : '000000';
}

async function startLogin(s: Setup, overrides: Overrides<AuthorizeParams> = {}): Promise<string> {
  const started = await s.flow.start(authorizeParams(overrides), IP);
  if (started.kind !== 'login') throw new Error(`expected a login page, got ${started.kind}`);
  return started.requestId;
}

function expectRedirect(result: StartResult | CompleteResult): URL {
  if (result.kind !== 'redirect') throw new Error(`expected a redirect, got ${result.kind}`);
  return new URL(result.location);
}

function expectErrorPage(result: StartResult | CompleteResult): string {
  expect(result).not.toHaveProperty('location');
  if (result.kind !== 'error_page') throw new Error(`expected an error page, got ${result.kind}`);
  return result.message;
}

/** Signs in with the right credentials and returns the authorization code. */
async function codeFor(s: Setup, overrides: Overrides<AuthorizeParams> = {}): Promise<string> {
  const requestId = await startLogin(s, overrides);
  const done = s.flow.complete({ requestId, password: PASSWORD, totp: rightCode(s.now()), ip: IP });
  const code = expectRedirect(done).searchParams.get('code');
  if (code === null) throw new Error('no code in the redirect');
  return code;
}

function redeemParams(code: string, overrides: Overrides<RedeemParams> = {}): RedeemParams {
  return compact<RedeemParams>({
    code,
    client_id: CLAUDE_CODE_ID,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    ...overrides,
  });
}

function grantError(run: () => void): TokenGrantError {
  try {
    run();
  } catch (err) {
    if (err instanceof TokenGrantError) return err;
    throw err;
  }
  throw new Error('expected a TokenGrantError');
}

describe('AuthorizationFlow start', () => {
  it('shows the login page with the client host, redirect host and resource', async () => {
    const s = setup();
    const started = await s.flow.start(authorizeParams(), IP);
    expect(started).toEqual({
      kind: 'login',
      requestId: expect.stringMatching(/^[A-Za-z0-9_-]+$/) as string,
      view: {
        clientHost: 'claude.ai',
        redirectHost: '127.0.0.1:53124',
        redirectOrigin: 'http://127.0.0.1:53124',
        resource: RESOURCE,
        loopbackRedirect: true,
        error: undefined,
      },
    });
  });

  it('marks a non-loopback redirect as such', async () => {
    const s = setup();
    const started = await s.flow.start(
      authorizeParams({ client_id: WEB_ID, redirect_uri: WEB_REDIRECT }),
      IP,
    );
    if (started.kind !== 'login') throw new Error('expected a login page');
    expect(started.view.redirectHost).toBe('claude.com');
    expect(started.view.loopbackRedirect).toBe(false);
  });

  it('accepts a resource with a trailing slash as the known resource', async () => {
    const s = setup();
    const started = await s.flow.start(authorizeParams({ resource: `${AGGREGATE}/` }), IP);
    if (started.kind !== 'login') throw new Error('expected a login page');
    expect(started.view.resource).toBe(AGGREGATE);
  });

  it('shows an error page, never a redirect, for a foreign or missing client_id', async () => {
    const s = setup();
    for (const client_id of ['https://evil.example/x', 'http://claude.ai/x', undefined]) {
      const message = expectErrorPage(await s.flow.start(authorizeParams({ client_id }), IP));
      expect(message).toMatch(/client_id/);
    }
  });

  it('shows the CIMD error message when the metadata cannot be fetched', async () => {
    const s = setup();
    const result = await s.flow.start(
      authorizeParams({ client_id: 'https://claude.ai/missing' }),
      IP,
    );
    expect(expectErrorPage(result)).toBe('Client metadata from claude.ai answered HTTP 404.');
  });

  it('shows an error page for a missing or unregistered redirect_uri', async () => {
    const s = setup();
    for (const redirect_uri of [
      undefined,
      'http://127.0.0.1:53124/other',
      'https://127.0.0.1/callback',
      'https://evil.example/callback',
      'not a url',
    ]) {
      const message = expectErrorPage(await s.flow.start(authorizeParams({ redirect_uri }), IP));
      expect(message).toMatch(/redirect_uri/);
    }
  });

  it('checks client_id and redirect_uri before anything else', async () => {
    const s = setup();
    const result = await s.flow.start(
      authorizeParams({
        redirect_uri: 'https://evil.example/callback',
        response_type: 'token',
        resource: undefined,
      }),
      IP,
    );
    expectErrorPage(result);
  });

  it('redirects with invalid_target, state and iss for an unknown or missing resource', async () => {
    const s = setup();
    for (const resource of ['http://127.0.0.1:8787/mcp/other', undefined]) {
      const url = expectRedirect(await s.flow.start(authorizeParams({ resource }), IP));
      expect(url.origin + url.pathname).toBe(REDIRECT);
      expect(url.searchParams.get('error')).toBe('invalid_target');
      expect(url.searchParams.get('error_description')).toBeTruthy();
      expect(url.searchParams.get('state')).toBe('state-1');
      expect(url.searchParams.get('iss')).toBe(ISS);
    }
  });

  it('redirects with unsupported_response_type for a response_type other than code', async () => {
    const s = setup();
    const url = expectRedirect(await s.flow.start(authorizeParams({ response_type: 'token' }), IP));
    expect(url.searchParams.get('error')).toBe('unsupported_response_type');
  });

  it('redirects with invalid_request for a missing, plain or malformed code challenge', async () => {
    const s = setup();
    for (const overrides of [
      { code_challenge: undefined },
      { code_challenge_method: undefined },
      { code_challenge_method: 'plain' },
      { code_challenge: 'too-short' },
      { code_challenge: `${CHALLENGE.slice(0, 42)}+` },
    ]) {
      const url = expectRedirect(await s.flow.start(authorizeParams(overrides), IP));
      expect(url.searchParams.get('error')).toBe('invalid_request');
    }
  });

  it('redirects with invalid_request for a state over 1 KiB and accepts exactly 1 KiB', async () => {
    const s = setup();
    // 'é' is two UTF-8 bytes: the cap counts bytes, not characters.
    for (const state of ['s'.repeat(MAX_STATE_BYTES + 1), 'é'.repeat(MAX_STATE_BYTES / 2 + 1)]) {
      const url = expectRedirect(await s.flow.start(authorizeParams({ state }), IP));
      expect(url.searchParams.get('error')).toBe('invalid_request');
    }
    expect(s.records.at(-1)).toMatchObject({
      event: 'authorize_rejected',
      reason: 'state too long',
    });
    const ok = await s.flow.start(authorizeParams({ state: 'é'.repeat(MAX_STATE_BYTES / 2) }), IP);
    expect(ok.kind).toBe('login');
  });

  it('leaves out state when none was given and keeps the redirect_uri query', async () => {
    const s = setup();
    const result = await s.flow.start(
      authorizeParams({
        client_id: WEB_ID,
        redirect_uri: WEB_REDIRECT,
        state: undefined,
        resource: undefined,
      }),
      IP,
    );
    if (result.kind !== 'redirect') throw new Error('expected a redirect');
    expect(result.location.startsWith(`${WEB_REDIRECT}&`)).toBe(true);
    const url = new URL(result.location);
    expect(url.searchParams.get('tenant')).toBe('a b');
    expect(url.searchParams.has('state')).toBe(false);
    expect(url.searchParams.get('iss')).toBe(ISS);
  });

  it('logs every rejection with a fixed reason and the client ip', async () => {
    const s = setup();
    await s.flow.start(authorizeParams({ client_id: 'https://evil.example/x' }), IP);
    await s.flow.start(authorizeParams({ redirect_uri: 'https://evil.example/cb' }), IP);
    await s.flow.start(authorizeParams({ resource: 'https://evil.example/r' }), IP);
    expect(s.records.map((r) => [r.event, r.client, r.reason, r.ip])).toEqual([
      ['authorize_rejected', 'evil.example', 'client_id rejected', IP],
      ['authorize_rejected', 'claude.ai', 'redirect_uri rejected', IP],
      ['authorize_rejected', 'claude.ai', 'resource unknown', IP],
    ]);
  });
});

describe('AuthorizationFlow complete', () => {
  it('redirects with code, state and iss after a right login', async () => {
    const s = setup();
    const requestId = await startLogin(s);
    const url = expectRedirect(
      s.flow.complete({ requestId, password: PASSWORD, totp: rightCode(s.now()), ip: IP }),
    );
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('iss')).toBe(ISS);
    expect(s.records.at(-1)).toEqual({
      event: 'login_ok',
      client: 'claude.ai',
      resource: RESOURCE,
      ip: IP,
      reason: null,
    });
  });

  it('removes the request after a successful login', async () => {
    const s = setup();
    const requestId = await startLogin(s);
    s.flow.complete({ requestId, password: PASSWORD, totp: rightCode(s.now()), ip: IP });
    s.advance(STEP_MS);
    expectErrorPage(
      s.flow.complete({ requestId, password: PASSWORD, totp: rightCode(s.now()), ip: IP }),
    );
  });

  it('shows an error page for an unknown or expired request', async () => {
    const s = setup();
    expectErrorPage(
      s.flow.complete({ requestId: 'nope', password: PASSWORD, totp: '123456', ip: IP }),
    );
    const requestId = await startLogin(s);
    s.advance(10 * MINUTE);
    expectErrorPage(
      s.flow.complete({ requestId, password: PASSWORD, totp: rightCode(s.now()), ip: IP }),
    );
  });

  it('shows an error page for a tampered request field', async () => {
    const s = setup();
    const requestId = await startLogin(s);
    const bytes = Buffer.from(requestId, 'base64url');
    for (const at of [0, 20, bytes.length - 1]) {
      const tampered = Buffer.from(bytes);
      tampered[at] = (tampered[at] ?? 0) ^ 1;
      const result = s.flow.complete({
        requestId: tampered.toString('base64url'),
        password: PASSWORD,
        totp: rightCode(s.now()),
        ip: IP,
      });
      expect(expectErrorPage(result)).toMatch(/unknown or expired/);
    }
    for (const garbage of ['', 'x', requestId.slice(0, 30)]) {
      expectErrorPage(
        s.flow.complete({ requestId: garbage, password: PASSWORD, totp: '123456', ip: IP }),
      );
    }
    // None of the failed attempts spent the real request.
    expectRedirect(
      s.flow.complete({ requestId, password: PASSWORD, totp: rightCode(s.now()), ip: IP }),
    );
  });

  it('shows an error page for a request sealed by another flow instance (a restart)', async () => {
    const s = setup();
    const requestId = await startLogin(s);
    const restarted = new AuthorizationFlow(s.deps);
    expectErrorPage(
      restarted.complete({ requestId, password: PASSWORD, totp: rightCode(s.now()), ip: IP }),
    );
  });

  it('keeps no state per opened login page', async () => {
    const s = setup();
    const first = await startLogin(s);
    for (let i = 0; i < 50; i += 1) await startLogin(s);
    expectRedirect(
      s.flow.complete({ requestId: first, password: PASSWORD, totp: rightCode(s.now()), ip: IP }),
    );
  });

  it('keeps the sealed request well under the 16 KiB form limit at the longest state', async () => {
    const s = setup();
    const requestId = await startLogin(s, { state: 's'.repeat(MAX_STATE_BYTES) });
    expect(requestId.length).toBeLessThan(4096);
  });

  it('keeps a request that is not yet expired', async () => {
    const s = setup();
    const requestId = await startLogin(s);
    s.advance(10 * MINUTE - 1);
    const done = s.flow.complete({
      requestId,
      password: PASSWORD,
      totp: rightCode(s.now()),
      ip: IP,
    });
    expect(done.kind).toBe('redirect');
  });

  it('gives the same answer for a wrong password and for a wrong code', async () => {
    const s = setup();
    const requestId = await startLogin(s);
    const wrongPassword = s.flow.complete({
      requestId,
      password: 'wrong password',
      totp: rightCode(s.now()),
      ip: IP,
    });
    const wrongTotp = s.flow.complete({
      requestId,
      password: PASSWORD,
      totp: wrongCode(s.now()),
      ip: IP,
    });
    const malformed = s.flow.complete({ requestId, password: PASSWORD, totp: 'abc', ip: IP });
    for (const result of [wrongPassword, wrongTotp, malformed]) {
      expect(result).toEqual({
        kind: 'login',
        requestId,
        view: {
          clientHost: 'claude.ai',
          redirectHost: '127.0.0.1:53124',
          redirectOrigin: 'http://127.0.0.1:53124',
          resource: RESOURCE,
          loopbackRedirect: true,
          error: 'Invalid password or code.',
        },
      });
    }
    expect(s.records.filter((r) => r.event === 'login_failed')).toHaveLength(3);
    expect(s.records.at(-1)).toEqual({
      event: 'login_failed',
      client: 'claude.ai',
      resource: RESOURCE,
      ip: IP,
      reason: 'invalid credentials',
    });
  });

  it('does not accept the same totp code for a second login', async () => {
    const s = setup();
    const totp = rightCode(s.now());
    const first = await startLogin(s);
    expect(s.flow.complete({ requestId: first, password: PASSWORD, totp, ip: IP }).kind).toBe(
      'redirect',
    );
    const second = await startLogin(s);
    const replay = s.flow.complete({ requestId: second, password: PASSWORD, totp, ip: IP });
    expect(replay.kind).toBe('login');
  });

  it('does not accept an older unused code after a newer one signed in', async () => {
    const s = setup();
    const newer = rightCode(s.now() + STEP_MS);
    const older = rightCode(s.now());
    const first = await startLogin(s);
    const done = s.flow.complete({ requestId: first, password: PASSWORD, totp: newer, ip: IP });
    expect(done.kind).toBe('redirect');
    const second = await startLogin(s);
    const late = s.flow.complete({ requestId: second, password: PASSWORD, totp: older, ip: IP });
    expect(late.kind).toBe('login');
  });

  it('does not burn the totp step on a wrong password', async () => {
    const s = setup();
    const totp = rightCode(s.now());
    const requestId = await startLogin(s);
    s.flow.complete({ requestId, password: 'wrong password', totp, ip: IP });
    expect(s.flow.complete({ requestId, password: PASSWORD, totp, ip: IP }).kind).toBe('redirect');
  });

  it('blocks the ip after five failures, even with right credentials', async () => {
    const s = setup();
    const requestId = await startLogin(s);
    for (let i = 0; i < 5; i += 1) {
      s.flow.complete({ requestId, password: 'wrong password', totp: '000000', ip: IP });
    }
    const blocked = s.flow.complete({
      requestId,
      password: PASSWORD,
      totp: rightCode(s.now()),
      ip: IP,
    });
    expect(blocked).toEqual({ kind: 'blocked', retryAfterSeconds: 900 });
    expect(s.records.at(-1)).toMatchObject({ event: 'login_blocked', ip: IP, client: 'claude.ai' });
  });

  it('never logs the password, the totp code or the authorization code', async () => {
    const s = setup();
    const requestId = await startLogin(s);
    const totp = rightCode(s.now());
    s.flow.complete({ requestId, password: 'wrong password', totp, ip: IP });
    const done = s.flow.complete({ requestId, password: PASSWORD, totp, ip: IP });
    const code = expectRedirect(done).searchParams.get('code') ?? 'missing';
    const logged = JSON.stringify(s.records);
    for (const secret of [PASSWORD, 'wrong password', totp, code, VERIFIER]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('AuthorizationFlow redeem', () => {
  it('issues tokens bound to the requested resource', async () => {
    const s = setup();
    const code = await codeFor(s);
    const response = s.flow.redeem(redeemParams(code), IP);
    expect(response.token_type).toBe('Bearer');
    expect(response.scope).toBe('offline_access');
    const info = await s.tokens.verifyAccessToken(response.access_token);
    expect(info.resource?.href).toBe(RESOURCE);
    expect(info.clientId).toBe(CLAUDE_CODE_ID);
  });

  it('keeps only the supported scopes', async () => {
    const s = setup();
    const some = await codeFor(s, { scope: 'mail offline_access admin offline_access' });
    expect(s.flow.redeem(redeemParams(some), IP).scope).toBe('offline_access');
    s.advance(STEP_MS);
    const none = await codeFor(s, { scope: undefined });
    expect(s.flow.redeem(redeemParams(none), IP)).not.toHaveProperty('scope');
  });

  it('accepts a matching resource, also with a trailing slash', async () => {
    const s = setup();
    const code = await codeFor(s);
    expect(() => s.flow.redeem(redeemParams(code, { resource: `${RESOURCE}/` }), IP)).not.toThrow();
  });

  it('rejects missing parameters with invalid_request', async () => {
    const s = setup();
    const code = await codeFor(s);
    for (const missing of ['code', 'client_id', 'redirect_uri', 'code_verifier'] as const) {
      const params = redeemParams(code, { [missing]: undefined });
      expect(grantError(() => s.flow.redeem(params, IP)).code).toBe('invalid_request');
    }
    expect(() => s.flow.redeem(redeemParams(code), IP)).not.toThrow();
  });

  it('rejects a wrong verifier, client, redirect_uri or resource with invalid_grant', async () => {
    const s = setup();
    const code = await codeFor(s);
    for (const overrides of [
      { code_verifier: `${VERIFIER.slice(0, -1)}A` },
      { code_verifier: 'short' },
      { code_verifier: `${VERIFIER}!` },
      { client_id: 'https://claude.com/oauth/other' },
      { redirect_uri: 'http://127.0.0.1:53125/callback' },
      { resource: AGGREGATE },
      { code: 'unknown-code' },
    ]) {
      expect(grantError(() => s.flow.redeem(redeemParams(code, overrides), IP)).code).toBe(
        'invalid_grant',
      );
    }
    // None of those consumed the code.
    expect(() => s.flow.redeem(redeemParams(code), IP)).not.toThrow();
  });

  it('rejects a code redeemed after 60 seconds', async () => {
    const s = setup();
    const code = await codeFor(s);
    s.advance(MINUTE);
    expect(grantError(() => s.flow.redeem(redeemParams(code), IP)).code).toBe('invalid_grant');
  });

  it('accepts a code just before its 60 seconds end', async () => {
    const s = setup();
    const code = await codeFor(s);
    s.advance(MINUTE - 1);
    expect(() => s.flow.redeem(redeemParams(code), IP)).not.toThrow();
  });

  it('revokes the first tokens when a code is redeemed a second time', async () => {
    const s = setup();
    const code = await codeFor(s);
    const first = s.flow.redeem(redeemParams(code), IP);
    await expect(s.tokens.verifyAccessToken(first.access_token)).resolves.toBeTruthy();

    expect(grantError(() => s.flow.redeem(redeemParams(code), IP)).code).toBe('invalid_grant');
    await expect(s.tokens.verifyAccessToken(first.access_token)).rejects.toThrow();
    expect(grantError(() => s.tokens.refresh(first.refresh_token, CLAUDE_CODE_ID, IP)).code).toBe(
      'invalid_grant',
    );
    expect(s.records.at(-1)).toEqual({
      event: 'code_reuse',
      client: 'claude.ai',
      resource: RESOURCE,
      ip: IP,
      reason: 'code reused',
    });
  });

  it('revokes the grant when a redeemed code comes back even with wrong parameters', async () => {
    // RFC 6749 4.1.2: a second use of a code revokes what it issued; the reuse alone proves the
    // code leaked, whoever sends it.
    const s = setup();
    const code = await codeFor(s);
    const first = s.flow.redeem(redeemParams(code), IP);
    const stranger = redeemParams(code, {
      client_id: 'https://claude.com/oauth/other',
      code_verifier: `${VERIFIER.slice(0, -1)}A`,
    });
    expect(grantError(() => s.flow.redeem(stranger, IP)).code).toBe('invalid_grant');
    await expect(s.tokens.verifyAccessToken(first.access_token)).rejects.toThrow();
    expect(s.records.at(-1)).toMatchObject({ event: 'code_reuse', ip: IP });
  });
});
