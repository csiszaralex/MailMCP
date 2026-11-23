import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../../src/http/app.js';
import type { Account } from '../../src/config/types.js';
import type { ToolDeps } from '../../src/server.js';
import type { MailProvider } from '../../src/mail/types.js';

const LOCAL_HOST = '127.0.0.1:8787';

const ACCOUNTS = [
  { id: 'a', address: 'a@example.org', provider: 'imap', level: 'read' },
  { id: 'b', address: 'b@example.org', provider: 'imap', level: 'read' },
] as Account[];

const deps: ToolDeps = {
  providerFor: (id) =>
    ({ account: ACCOUNTS.find((a) => a.id === id) }) as Partial<MailProvider> as MailProvider,
  log: () => undefined,
};

const app = createApp(ACCOUNTS, deps);
const clients: Client[] = [];

async function connect(path: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:8787${path}`), {
    fetch: (input, init) => {
      // In-process requests carry no Host header (the Node server adds it on the wire).
      const request = new Request(input, init);
      request.headers.set('host', LOCAL_HOST);
      return Promise.resolve(app.fetch(request));
    },
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe('HTTP app', () => {
  it('serves all accounts on /mcp', async () => {
    const client = await connect('/mcp');
    const search = (await client.listTools()).tools.find((t) => t.name === 'search');
    expect(Object.keys(search?.inputSchema.properties ?? {})).toContain('account');
  });

  it('serves one account on /mcp/<id>', async () => {
    const client = await connect('/mcp/b');
    const search = (await client.listTools()).tools.find((t) => t.name === 'search');
    expect(Object.keys(search?.inputSchema.properties ?? {})).not.toContain('account');
  });

  it('returns 404 for unknown accounts and paths', async () => {
    const headers = { host: LOCAL_HOST };
    const unknownAccount = await app.request('http://127.0.0.1:8787/mcp/nope', {
      method: 'POST',
      headers,
    });
    expect(unknownAccount.status).toBe(404);
    expect((await app.request('http://127.0.0.1:8787/other', { headers })).status).toBe(404);
  });

  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const response = await app.request('http://evil.example/mcp', {
      method: 'POST',
      headers: { host: 'evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).not.toBe(404);
  });

  it('rejects a foreign Origin header', async () => {
    const response = await app.request('http://127.0.0.1:8787/mcp', {
      method: 'POST',
      headers: {
        host: LOCAL_HOST,
        origin: 'http://evil.example',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });
});
