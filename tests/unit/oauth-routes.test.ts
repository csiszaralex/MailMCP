import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { CimdResolver } from '../../src/auth/cimd.js';
import { AuthorizationFlow } from '../../src/auth/flow.js';
import { LoginLimiter } from '../../src/auth/limiter.js';
import { PAGE_HEADERS } from '../../src/auth/login-page.js';
import { hashPassword, parsePasswordHash } from '../../src/auth/password.js';
import { authorizationServerMetadata, resourceUrls } from '../../src/auth/resources.js';
import { TokenService } from '../../src/auth/tokens.js';
import { totpAt } from '../../src/auth/totp.js';
import { parseJsonText } from '../../src/boundary.js';
import { registerOAuthRoutes } from '../../src/http/oauth-routes.js';
import { Store } from '../../src/store/store.js';

/** 15 seconds into a 30 second TOTP step, so a few seconds of test time stay in the same step. */
const START = 1_800_000_015_000;
const STEP_MS = 30_000;

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = parsePasswordHash(hashPassword(PASSWORD));
const TOTP_SECRET = Buffer.from('12345678901234567890');

const PUBLIC_URL = new URL('http://127.0.0.1:8787');
const ORIGIN = 'http://127.0.0.1:8787';
const RESOURCE = 'http://127.0.0.1:8787/mcp/a';

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
const REDIRECT = 'http://127.0.0.1:53124/callback';

/** RFC 7636 appendix B verifier; the challenge is computed here, not copied. */
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

const TokenBody = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number(),
  refresh_token: z.string(),
});

const open: Store[] = [];

afterEach(() => {
  for (const store of open.splice(0)) store.close();
});

function setup(): Hono {
  const store = Store.open(':memory:');
  open.push(store);
  const clock = (): number => START;
  const log = (): void => undefined;
  const fetchFn: typeof fetch = (input) =>
    Promise.resolve(
      input === CLAUDE_CODE_ID
        ? new Response(JSON.stringify(CLAUDE_CODE_DOC), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response('not found', { status: 404 }),
    );
  const resources = resourceUrls(PUBLIC_URL, ['a']);
  const tokens = new TokenService(store, clock, log);
  const flow = new AuthorizationFlow({
    publicUrl: PUBLIC_URL,
    resources: new Set(resources.values()),
    cimd: new CimdResolver(fetchFn, clock),
    tokens,
    limiter: new LoginLimiter(store, clock),
    store,
    passwordHash: PASSWORD_HASH,
    totpSecret: TOTP_SECRET,
    clock,
    log,
  });
  const app = new Hono();
  registerOAuthRoutes(app, {
    publicUrl: PUBLIC_URL,
    resources,
    flow,
    tokens,
    behindProxy: false,
    remoteAddress: () => '203.0.113.7',
  });
  return app;
}

function rightCode(): string {
  return totpAt(TOTP_SECRET, Math.floor(START / STEP_MS));
}

function authorizeUrl(overrides: Record<string, string | undefined> = {}): string {
  const values: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: CLAUDE_CODE_ID,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    scope: 'offline_access',
    state: 'state-1',
    ...overrides,
  };
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) query.append(name, value);
  }
  return `/authorize?${query.toString()}`;
}

async function json(res: Response): Promise<ReturnType<typeof parseJsonText>> {
  return parseJsonText(await res.text());
}

/** Opens a login page and returns the sealed pending request from its hidden field. */
async function startLogin(app: Hono): Promise<string> {
  const res = await app.request(authorizeUrl());
  expect(res.status).toBe(200);
  const match = /name="request" value="([^"]+)"/.exec(await res.text());
  if (match?.[1] === undefined) throw new Error('no request id on the login page');
  return match[1];
}

function postAuthorize(
  app: Hono,
  fields: Record<string, string>,
  headers: Record<string, string> = { Origin: ORIGIN },
): Promise<Response> {
  return Promise.resolve(
    app.request('/authorize', {
      method: 'POST',
      headers,
      body: new URLSearchParams(fields),
    }),
  );
}

function postToken(app: Hono, fields: Record<string, string>): Promise<Response> {
  return Promise.resolve(
    app.request('/token', { method: 'POST', body: new URLSearchParams(fields) }),
  );
}

/** Signs in with the right credentials and returns the authorization code. */
async function codeFor(app: Hono): Promise<string> {
  const request = await startLogin(app);
  const res = await postAuthorize(app, { request, password: PASSWORD, totp: rightCode() });
  expect(res.status).toBe(302);
  const code = new URL(res.headers.get('location') ?? '').searchParams.get('code');
  if (code === null) throw new Error('no code in the redirect');
  return code;
}

function redeem(app: Hono, code: string): Promise<Response> {
  return postToken(app, {
    grant_type: 'authorization_code',
    code,
    client_id: CLAUDE_CODE_ID,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: RESOURCE,
  });
}

function expectNoStore(res: Response): void {
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('pragma')).toBe('no-cache');
}

describe('metadata', () => {
  it('serves the authorization server metadata to any origin', async () => {
    const res = await setup().request('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await json(res)).toEqual(authorizationServerMetadata(PUBLIC_URL));
  });

  it('serves the protected resource metadata of the aggregate endpoint', async () => {
    const res = await setup().request('/.well-known/oauth-protected-resource/mcp');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await json(res)).toMatchObject({
      resource: 'http://127.0.0.1:8787/mcp',
      authorization_servers: ['http://127.0.0.1:8787'],
      scopes_supported: ['offline_access'],
      resource_name: 'MailMCP',
    });
  });

  it('serves the protected resource metadata of an account endpoint', async () => {
    const res = await setup().request('/.well-known/oauth-protected-resource/mcp/a');
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ resource: 'http://127.0.0.1:8787/mcp/a' });
  });

  it('answers 404 for an unknown account', async () => {
    const res = await setup().request('/.well-known/oauth-protected-resource/mcp/b');
    expect(res.status).toBe(404);
  });

  it('answers HEAD and refuses other methods with 405', async () => {
    const app = setup();
    const head = await app.request('/.well-known/oauth-authorization-server', { method: 'HEAD' });
    expect(head.status).toBe(200);
    const post = await app.request('/.well-known/oauth-protected-resource/mcp/a', {
      method: 'POST',
    });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('GET /authorize', () => {
  it('shows the login page with a CSP that lets the form redirect to the client', async () => {
    const res = await setup().request(authorizeUrl());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('content-security-policy')).toContain(
      "form-action 'self' http://127.0.0.1:53124",
    );
    expect(await res.text()).toContain('claude.ai');
  });

  it('shows an error page without a redirect for a foreign client_id (Review Focus 1)', async () => {
    const res = await setup().request(
      authorizeUrl({ client_id: 'https://evil.example/client-metadata' }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-security-policy')).toBe(
      PAGE_HEADERS['Content-Security-Policy'],
    );
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self';");
  });

  it('redirects an unknown resource with invalid_target, state and iss', async () => {
    const res = await setup().request(authorizeUrl({ resource: 'http://127.0.0.1:8787/mcp/b' }));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get('error')).toBe('invalid_target');
    expect(location.searchParams.get('state')).toBe('state-1');
    expect(location.searchParams.get('iss')).toBe(ORIGIN);
  });

  it('takes the first value of a repeated parameter', async () => {
    const url = `${authorizeUrl()}&resource=${encodeURIComponent('http://127.0.0.1:8787/mcp/b')}`;
    const res = await setup().request(url);
    expect(res.status).toBe(200);
  });
});

describe('POST /authorize', () => {
  it('refuses a foreign Origin and a missing Origin with 403', async () => {
    const app = setup();
    const request = await startLogin(app);
    const fields = { request, password: PASSWORD, totp: rightCode() };
    const foreign = await postAuthorize(app, fields, { Origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('location')).toBeNull();
    const missing = await postAuthorize(app, fields, {});
    expect(missing.status).toBe(403);
  });

  it('refuses a JSON body with 400', async () => {
    const app = setup();
    const request = await startLogin(app);
    const res = await app.request('/authorize', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ request, password: PASSWORD, totp: rightCode() }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('refuses a body over 16 KiB with 413', async () => {
    const res = await postAuthorize(setup(), { request: 'x'.repeat(16 * 1024), password: '' });
    expect(res.status).toBe(413);
  });

  it('redirects to the redirect_uri with code, state and iss after a right sign-in', async () => {
    const app = setup();
    const request = await startLogin(app);
    const res = await postAuthorize(app, { request, password: PASSWORD, totp: rightCode() });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get('code')).not.toBeNull();
    expect(location.searchParams.get('state')).toBe('state-1');
    expect(location.searchParams.get('iss')).toBe(ORIGIN);
  });

  it('shows the login page again after a wrong password', async () => {
    const app = setup();
    const request = await startLogin(app);
    const res = await postAuthorize(app, { request, password: 'wrong', totp: rightCode() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain(
      "form-action 'self' http://127.0.0.1:53124",
    );
    const html = await res.text();
    expect(html).toContain('Invalid password or code.');
    expect(html).not.toContain('wrong');
  });

  it('shows an error page for an unknown request', async () => {
    const res = await postAuthorize(setup(), {
      request: 'unknown',
      password: PASSWORD,
      totp: rightCode(),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('answers 429 with Retry-After after five failures', async () => {
    const app = setup();
    const request = await startLogin(app);
    for (let i = 0; i < 5; i += 1) {
      const res = await postAuthorize(app, { request, password: 'wrong', totp: rightCode() });
      expect(res.status).toBe(200);
    }
    const res = await postAuthorize(app, { request, password: PASSWORD, totp: rightCode() });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await res.text()).toContain('Too many failed sign-ins. Try again later.');
  });
});

describe('POST /token', () => {
  it('refuses a JSON body with invalid_request', async () => {
    const res = await setup().request('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code' }),
    });
    expect(res.status).toBe(400);
    expectNoStore(res);
    expect(await json(res)).toMatchObject({ error: 'invalid_request' });
  });

  it('refuses a body over 16 KiB with invalid_request', async () => {
    const res = await postToken(setup(), { grant_type: 'x'.repeat(16 * 1024) });
    expect(res.status).toBe(413);
    expectNoStore(res);
    expect(await json(res)).toMatchObject({ error: 'invalid_request' });
  });

  it('refuses an unknown grant_type with unsupported_grant_type', async () => {
    const res = await postToken(setup(), { grant_type: 'password' });
    expect(res.status).toBe(400);
    expectNoStore(res);
    expect(await json(res)).toMatchObject({ error: 'unsupported_grant_type' });
  });

  it('refuses an unknown code with invalid_grant', async () => {
    const res = await redeem(setup(), 'unknown');
    expect(res.status).toBe(400);
    expectNoStore(res);
    expect(await json(res)).toMatchObject({ error: 'invalid_grant' });
  });

  it('redeems a code for a Bearer token', async () => {
    const app = setup();
    const res = await redeem(app, await codeFor(app));
    expect(res.status).toBe(200);
    expectNoStore(res);
    const body = TokenBody.parse(await json(res));
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3600);
  });

  it('rotates a refresh token and refuses the old one with invalid_grant', async () => {
    const app = setup();
    const issued = TokenBody.parse(await json(await redeem(app, await codeFor(app))));
    const fields = {
      grant_type: 'refresh_token',
      refresh_token: issued.refresh_token,
      client_id: CLAUDE_CODE_ID,
    };
    const rotated = await postToken(app, fields);
    expect(rotated.status).toBe(200);
    expectNoStore(rotated);
    expect(TokenBody.parse(await json(rotated)).refresh_token).not.toBe(issued.refresh_token);
    const reused = await postToken(app, fields);
    expect(reused.status).toBe(400);
    expectNoStore(reused);
    expect(await json(reused)).toMatchObject({ error: 'invalid_grant' });
  });

  it('requires client_id for a refresh', async () => {
    const res = await postToken(setup(), { grant_type: 'refresh_token', refresh_token: 'r' });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'invalid_request' });
  });
});
