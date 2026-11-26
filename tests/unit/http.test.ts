import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ACCESS_TOKEN_TTL_MS } from '../../src/auth/tokens.js';
import { MAX_REQUEST_BODY_BYTES } from '../../src/http/app.js';
import {
  accessTokenFor,
  CLAUDE_CODE_ID,
  createTestApp,
  LOCAL_HOST,
  type TestApp,
} from './auth-fixture.js';

const ORIGIN = 'http://127.0.0.1:8787';
const resource = (path: string): string => `${ORIGIN}${path}`;

const clients: Client[] = [];
const apps: TestApp[] = [];

function setup(publicUrl?: URL): TestApp {
  const test = createTestApp(publicUrl);
  apps.push(test);
  return test;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  for (const test of apps.splice(0)) test.store.close();
});

async function connect(test: TestApp, path: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(resource(path)), {
    fetch: (input, init) => {
      const request = new Request(input, init);
      request.headers.set('authorization', `Bearer ${token}`);
      return test.fetch(request);
    },
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

/** A JSON-RPC POST as an MCP client sends it, with an optional Bearer token. */
function post(test: TestApp, path: string, token?: string, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    host: LOCAL_HOST,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return test.app.request(resource(path), {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

function metadataUrl(path: string): string {
  return `${ORIGIN}/.well-known/oauth-protected-resource${path}`;
}

describe('HTTP app', () => {
  it('serves all accounts on /mcp', async () => {
    const test = setup();
    const client = await connect(test, '/mcp', accessTokenFor(test.tokens, resource('/mcp')));
    const search = (await client.listTools()).tools.find((t) => t.name === 'search');
    expect(Object.keys(search?.inputSchema.properties ?? {})).toContain('account');
  });

  it('serves one account on /mcp/<id>', async () => {
    const test = setup();
    const client = await connect(test, '/mcp/b', accessTokenFor(test.tokens, resource('/mcp/b')));
    const search = (await client.listTools()).tools.find((t) => t.name === 'search');
    expect(Object.keys(search?.inputSchema.properties ?? {})).not.toContain('account');
  });

  it('returns 404 for unknown accounts and paths, before asking for a token', async () => {
    const test = setup();
    const headers = { host: LOCAL_HOST };
    const unknownAccount = await test.app.request(resource('/mcp/nope'), {
      method: 'POST',
      headers,
    });
    expect(unknownAccount.status).toBe(404);
    expect((await test.app.request(resource('/other'), { headers })).status).toBe(404);
  });

  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const test = setup();
    const token = accessTokenFor(test.tokens, resource('/mcp'));
    const response = await test.app.request('http://evil.example/mcp', {
      method: 'POST',
      headers: {
        host: 'evil.example',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });

  it('rejects a foreign Origin header', async () => {
    const test = setup();
    const token = accessTokenFor(test.tokens, resource('/mcp'));
    const response = await post(test, '/mcp', token, { origin: 'http://evil.example' });
    expect(response.status).toBe(403);
  });

  it('rejects an Origin with our hostname but another port or scheme (D30)', async () => {
    const test = setup();
    const token = accessTokenFor(test.tokens, resource('/mcp'));
    for (const origin of ['http://127.0.0.1:9999', 'https://127.0.0.1:8787', 'null']) {
      expect((await post(test, '/mcp', token, { origin })).status).toBe(403);
    }
    expect((await post(test, '/mcp', token, { origin: ORIGIN })).status).toBe(200);
  });

  // https, because the SDK's buildOAuthProtectedResourceMetadata accepts an http issuer only for
  // localhost and 127.0.0.1.
  it('accepts the Host and Origin of a bracketed IPv6 public URL', async () => {
    const test = setup(new URL('https://[::1]:8787'));
    const ipv6 = 'https://[::1]:8787/mcp';
    const token = accessTokenFor(test.tokens, ipv6);
    const response = await test.fetch(ipv6, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        origin: 'https://[::1]:8787',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(200);
  });
});

describe('Bearer gate', () => {
  it('answers 401 without a token and points to the endpoint metadata', async () => {
    const response = await post(setup(), '/mcp/b');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      `resource_metadata="${metadataUrl('/mcp/b')}"`,
    );
  });

  it('answers 401 for an unknown token', async () => {
    const response = await post(setup(), '/mcp', 'not-a-token');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      `resource_metadata="${metadataUrl('/mcp')}"`,
    );
  });

  it('refuses a /mcp/a token on /mcp and on /mcp/b (Review Focus 2)', async () => {
    const test = setup();
    const token = accessTokenFor(test.tokens, resource('/mcp/a'));
    expect((await post(test, '/mcp/a', token)).status).toBe(200);
    const aggregate = await post(test, '/mcp', token);
    expect(aggregate.status).toBe(401);
    expect(aggregate.headers.get('www-authenticate')).toContain(
      `resource_metadata="${metadataUrl('/mcp')}"`,
    );
    const other = await post(test, '/mcp/b', token);
    expect(other.status).toBe(401);
    expect(other.headers.get('www-authenticate')).toContain(
      `resource_metadata="${metadataUrl('/mcp/b')}"`,
    );
  });

  it('refuses a /mcp token on /mcp/a (Review Focus 2)', async () => {
    const test = setup();
    const token = accessTokenFor(test.tokens, resource('/mcp'));
    expect((await post(test, '/mcp', token)).status).toBe(200);
    expect((await post(test, '/mcp/a', token)).status).toBe(401);
  });

  it('refuses an expired token', async () => {
    const test = setup();
    const token = accessTokenFor(test.tokens, resource('/mcp/a'));
    test.advance(ACCESS_TOKEN_TTL_MS + 1000);
    const response = await post(test, '/mcp/a', token);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('refuses a token of a revoked grant', async () => {
    const test = setup();
    const grantId = test.tokens.createGrant({
      clientId: CLAUDE_CODE_ID,
      resource: resource('/mcp/a'),
      scope: 'offline_access',
    });
    const token = test.tokens.issue(grantId).access_token;
    test.tokens.revokeGrant(grantId);
    expect((await post(test, '/mcp/a', token)).status).toBe(401);
  });
});

describe('request body limit', () => {
  const postRaw = (test: TestApp, body: string, extra: Record<string, string> = {}) =>
    test.app.request(resource('/mcp'), {
      method: 'POST',
      headers: {
        host: LOCAL_HOST,
        authorization: `Bearer ${accessTokenFor(test.tokens, resource('/mcp'))}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...extra,
      },
      body,
    });

  it('accepts a request above the SDK default of 4 MiB', async () => {
    const padding = 'x'.repeat(5 * 1024 * 1024);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { padding },
    });
    expect((await postRaw(setup(), body)).status).not.toBe(413);
  });

  it('answers 413 above MAX_REQUEST_BODY_BYTES with a valid token', async () => {
    const response = await postRaw(setup(), '{}', {
      'content-length': String(MAX_REQUEST_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
  });
});
