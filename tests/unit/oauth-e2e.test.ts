import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { totpAt } from '../../src/auth/totp.js';
import { parseJsonText } from '../../src/boundary.js';
import {
  CLAUDE_CODE_ID,
  createTestApp,
  PASSWORD,
  TOTP_SECRET,
  type TestApp,
} from './auth-fixture.js';

/** The only URL the client knows up front: the MCP endpoint it was configured with. */
const MCP_URL = 'http://127.0.0.1:8787/mcp/a';
const REDIRECT = 'http://127.0.0.1:53124/callback';
const STATE = 'e2e-state';
const STEP_MS = 30_000;

/** RFC 7636 appendix B verifier; the challenge is computed here, not copied. */
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

const ResourceMetadata = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()).min(1),
});
const ServerMetadata = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
});
const TokenBody = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number(),
  refresh_token: z.string(),
});

const apps: TestApp[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  for (const test of apps.splice(0)) test.store.close();
});

async function listToolNames(test: TestApp, resource: string, token: string): Promise<string[]> {
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    fetch: (input, init) => {
      const request = new Request(input, init);
      request.headers.set('authorization', `Bearer ${token}`);
      return test.fetch(request);
    },
  });
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  await client.connect(transport);
  clients.push(client);
  return (await client.listTools()).tools.map((t) => t.name);
}

async function jsonOf<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(parseJsonText(await res.text()));
}

describe('OAuth round over HTTP, as Claude Code runs it', () => {
  it('discovers, signs in, calls a tool, refreshes and calls again', async () => {
    const test = createTestApp();
    apps.push(test);

    // 1. The first MCP request has no token and learns where the resource metadata lives.
    const unauthorized = await test.fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(unauthorized.status).toBe(401);
    const challenge = unauthorized.headers.get('www-authenticate') ?? '';
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    if (metadataUrl === undefined) throw new Error('no resource_metadata in the challenge');

    // 2. Protected resource metadata, then the authorization server metadata (RFC 8414).
    const prm = await jsonOf(await test.fetch(metadataUrl), ResourceMetadata);
    expect(prm.resource).toBe(MCP_URL);
    const issuer = prm.authorization_servers[0] ?? '';
    const as = await jsonOf(
      await test.fetch(`${issuer}/.well-known/oauth-authorization-server`),
      ServerMetadata,
    );
    expect(as.issuer).toBe(issuer);

    // 3. The browser opens the authorization endpoint with PKCE and the resource.
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: CLAUDE_CODE_ID,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      resource: prm.resource,
      scope: 'offline_access',
      state: STATE,
    });
    const page = await test.fetch(`${as.authorization_endpoint}?${query.toString()}`);
    expect(page.status).toBe(200);
    const requestId = /name="request" value="([^"]+)"/.exec(await page.text())?.[1];
    if (requestId === undefined) throw new Error('no request id on the login page');

    // 4. The user signs in; the form posts from the page's own origin.
    const signIn = await test.fetch(as.authorization_endpoint, {
      method: 'POST',
      headers: { origin: new URL(as.authorization_endpoint).origin },
      body: new URLSearchParams({
        request: requestId,
        password: PASSWORD,
        totp: totpAt(TOTP_SECRET, Math.floor(test.now() / STEP_MS)),
      }),
    });
    expect(signIn.status).toBe(302);
    const callback = new URL(signIn.headers.get('location') ?? '');
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT);
    expect(callback.searchParams.get('state')).toBe(STATE);
    expect(callback.searchParams.get('iss')).toBe(as.issuer);
    const code = callback.searchParams.get('code');
    if (code === null) throw new Error('no code in the redirect');

    // 5. The code becomes a token pair, and the token reaches the MCP endpoint.
    const issued = await jsonOf(
      await test.fetch(as.token_endpoint, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: CLAUDE_CODE_ID,
          redirect_uri: REDIRECT,
          code_verifier: VERIFIER,
          resource: prm.resource,
        }),
      }),
      TokenBody,
    );
    expect(await listToolNames(test, prm.resource, issued.access_token)).toContain('search');

    // 6. The refresh token rotates into a new pair that works too.
    const refreshed = await jsonOf(
      await test.fetch(as.token_endpoint, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: issued.refresh_token,
          client_id: CLAUDE_CODE_ID,
        }),
      }),
      TokenBody,
    );
    expect(refreshed.access_token).not.toBe(issued.access_token);
    expect(await listToolNames(test, prm.resource, refreshed.access_token)).toContain('search');
  });
});
