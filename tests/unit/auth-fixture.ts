import type { Hono } from 'hono';
import { CimdResolver } from '../../src/auth/cimd.js';
import { AuthorizationFlow } from '../../src/auth/flow.js';
import { LoginLimiter } from '../../src/auth/limiter.js';
import { hashPassword, parsePasswordHash } from '../../src/auth/password.js';
import { resourceUrls } from '../../src/auth/resources.js';
import { TokenService } from '../../src/auth/tokens.js';
import type { Account } from '../../src/config/types.js';
import { createApp } from '../../src/http/app.js';
import type { MailProvider } from '../../src/mail/types.js';
import type { ToolDeps } from '../../src/server.js';
import { Store } from '../../src/store/store.js';

/** The app under test: createApp with the real auth modules on an in-memory store. */

export const PUBLIC_URL = new URL('http://127.0.0.1:8787');
/** In-process requests carry no Host header (the Node server adds it on the wire). */
export const LOCAL_HOST = PUBLIC_URL.host;
/** The peer address every in-process request comes from. */
export const CLIENT_IP = '203.0.113.7';

export const PASSWORD = 'correct horse battery staple';
/** The RFC 6238 test key. */
export const TOTP_SECRET = Buffer.from('12345678901234567890');
const PASSWORD_HASH = parsePasswordHash(hashPassword(PASSWORD));

export const CLAUDE_CODE_ID = 'https://claude.ai/oauth/claude-code-client-metadata';
const CLAUDE_CODE_DOC = {
  client_id: CLAUDE_CODE_ID,
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

export const ACCOUNTS = [
  { id: 'a', address: 'a@example.org', provider: 'imap', level: 'read' },
  { id: 'b', address: 'b@example.org', provider: 'imap', level: 'read' },
] as Account[];

const deps: ToolDeps = {
  providerFor: (id) =>
    ({ account: ACCOUNTS.find((a) => a.id === id) }) as Partial<MailProvider> as MailProvider,
  writerFor: () => {
    throw new Error('every account is read-only, so no write tool asks for a writer');
  },
  log: () => undefined,
};

export interface TestApp {
  app: Hono;
  tokens: TokenService;
  store: Store;
  /** The injected clock's current time in milliseconds. */
  now: () => number;
  advance: (ms: number) => void;
  /** Sends a request to the app with the Host header a real client would send. */
  fetch: typeof fetch;
}

/**
 * The clock starts at the real time: the SDK's Bearer gate checks expiresAt against Date.now(),
 * so a token issued on a fixed clock far from today would look expired or never expire.
 */
export function createTestApp(publicUrl: URL = PUBLIC_URL): TestApp {
  let current = Date.now();
  const clock = (): number => current;
  const log = (): void => undefined;
  const store = Store.open(':memory:');
  const fetchCimd: typeof fetch = (input) =>
    Promise.resolve(
      input === CLAUDE_CODE_ID
        ? new Response(JSON.stringify(CLAUDE_CODE_DOC), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response('not found', { status: 404 }),
    );
  const tokens = new TokenService(store, clock, log);
  const resources = resourceUrls(
    publicUrl,
    ACCOUNTS.map((a) => a.id),
  );
  const flow = new AuthorizationFlow({
    publicUrl,
    resources: new Set(resources.values()),
    cimd: new CimdResolver(fetchCimd, clock),
    tokens,
    limiter: new LoginLimiter(store, clock),
    store,
    passwordHash: PASSWORD_HASH,
    totpSecret: TOTP_SECRET,
    clock,
    log,
  });
  const app = createApp(ACCOUNTS, deps, {
    publicUrl,
    oauth: { flow, tokens, behindProxy: false, remoteAddress: () => CLIENT_IP },
  });
  return {
    app,
    tokens,
    store,
    now: clock,
    advance: (ms) => {
      current += ms;
    },
    fetch: (input, init) => {
      const request = new Request(input, init);
      request.headers.set('host', publicUrl.host);
      return Promise.resolve(app.fetch(request));
    },
  };
}

/** Issues an access token for a resource directly, without the login round. */
export function accessTokenFor(tokens: TokenService, resource: string): string {
  const grantId = tokens.createGrant({
    clientId: CLAUDE_CODE_ID,
    resource,
    scope: 'offline_access',
  });
  return tokens.issue(grantId, CLIENT_IP).access_token;
}
