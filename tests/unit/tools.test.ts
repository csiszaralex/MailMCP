import { afterEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { buildMcpServer, type ToolDeps } from '../../src/server.js';
import type { Account } from '../../src/config/types.js';
import type { LogRecord } from '../../src/log.js';
import type { MailProvider, MessageDetail, MessageSummary } from '../../src/mail/types.js';
import { encodeMessageId, encodeThreadId } from '../../src/ids.js';

function account(id: string): Account {
  return { id, address: `${id}@example.org`, provider: 'imap', level: 'read' } as Account;
}

const ACCOUNTS = [account('a'), account('b')];

function summary(acc: string): MessageSummary {
  return {
    id: encodeMessageId({ account: acc, mailbox: 'INBOX', uidValidity: '1', uid: 1 }),
    threadId: 't',
    account: acc,
    mailbox: 'INBOX',
    date: '2026-11-20T00:00:00.000Z',
    from: [{ name: 'Bob', address: 'bob@x.org' }],
    to: [],
    cc: [],
    subject: `hello from ${acc}`,
    flags: [],
    labels: [],
  };
}

function fakeProvider(acc: Account): MailProvider {
  const detail: MessageDetail = {
    ...summary(acc.id),
    messageIdHeader: '<m@x>',
    inReplyTo: null,
    attachments: [],
    format: 'plain',
    body: 'Body text',
  };
  return {
    account: acc,
    search: () => Promise.resolve({ total: 1, messages: [summary(acc.id)] }),
    getMessage: () => Promise.resolve(detail),
    getThread: () => Promise.resolve([detail]),
    downloadAttachment: () =>
      Promise.resolve({ filename: 'a.pdf', mimeType: 'application/pdf', data: Buffer.from('pdf') }),
    listLabels: () => Promise.resolve([{ name: 'INBOX', specialUse: null }]),
    listDrafts: () => Promise.resolve({ total: 0, messages: [] }),
  };
}

const logs: LogRecord[] = [];
const deps: ToolDeps = {
  providerFor: (id) => fakeProvider(ACCOUNTS.find((a) => a.id === id) ?? account(id)),
  log: (record) => logs.push(record),
};

const clients: Client[] = [];

async function connect(scopedAccountId?: string): Promise<Client> {
  const scope = {
    accounts:
      scopedAccountId === undefined ? ACCOUNTS : ACCOUNTS.filter((a) => a.id === scopedAccountId),
    scopedAccountId,
  };
  const server = buildMcpServer(scope, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === 'text' ? first.text : '';
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  logs.length = 0;
});

describe('tool list', () => {
  it('registers the eight read tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'download_attachment',
      'get_draft',
      'get_message',
      'get_thread',
      'list_accounts',
      'list_drafts',
      'list_labels',
      'search',
    ]);
  });

  it('exposes the account parameter only without a scope', async () => {
    const all = await connect();
    const scoped = await connect('b');
    const searchAll = (await all.listTools()).tools.find((t) => t.name === 'search');
    const searchScoped = (await scoped.listTools()).tools.find((t) => t.name === 'search');
    expect(Object.keys(searchAll?.inputSchema.properties ?? {})).toContain('account');
    expect(Object.keys(searchScoped?.inputSchema.properties ?? {})).not.toContain('account');
  });

  it('warns that mail content is untrusted', async () => {
    const client = await connect();
    const getMessage = (await client.listTools()).tools.find((t) => t.name === 'get_message');
    expect(getMessage?.description).toContain('untrusted');
  });
});

describe('tool calls', () => {
  it('lists accounts in scope only', async () => {
    const client = await connect('b');
    const result = await client.callTool({ name: 'list_accounts', arguments: {} });
    expect(JSON.parse(textOf(result)) as object).toEqual([
      { id: 'b', address: 'b@example.org', provider: 'imap', level: 'read' },
    ]);
  });

  it('searches all accounts when no account is given', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'search', arguments: { query: 'hello' } });
    const parsed = JSON.parse(textOf(result)) as { messages: { account: string }[] };
    expect(parsed.messages.map((m) => m.account).sort()).toEqual(['a', 'b']);
    expect(logs[0]).toMatchObject({ tool: 'search', account: null, outcome: 'ok' });
  });

  it('shapes results by view', async () => {
    const client = await connect('a');
    const result = await client.callTool({ name: 'search', arguments: { view: 'ids' } });
    const parsed = JSON.parse(textOf(result)) as { messages: object[] };
    expect(Object.keys(parsed.messages[0] ?? {}).sort()).toEqual(['account', 'id', 'threadId']);
  });

  it('refuses ids of accounts outside the scope', async () => {
    const client = await connect('a');
    const foreign = encodeMessageId({ account: 'b', mailbox: 'INBOX', uidValidity: '1', uid: 1 });
    const result = await client.callTool({
      name: 'get_message',
      arguments: { messageId: foreign },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not available');
    expect(logs[0]).toMatchObject({
      tool: 'get_message',
      outcome: 'error',
      code: 'unknown_account',
    });
  });

  it('logs the message id and its account for id-based tools', async () => {
    const client = await connect();
    const id = encodeMessageId({ account: 'b', mailbox: 'INBOX', uidValidity: '1', uid: 7 });
    await client.callTool({ name: 'get_message', arguments: { messageId: id } });
    await client.callTool({ name: 'get_draft', arguments: { draftId: id } });
    await client.callTool({
      name: 'download_attachment',
      arguments: { messageId: id, attachmentId: '2' },
    });
    expect(logs.map((l) => [l.tool, l.account, l.id])).toEqual([
      ['get_message', 'b', id],
      ['get_draft', 'b', id],
      ['download_attachment', 'b', id],
    ]);
  });

  it('logs Gmail thread ids but not thread ids that embed a Message-ID', async () => {
    const client = await connect();
    const gmail = encodeThreadId({ kind: 'gmail', account: 'a', gmailThreadId: '17900' });
    const refs = encodeThreadId({
      kind: 'references',
      account: 'b',
      mailbox: 'INBOX',
      rootMessageId: '<root@example.org>',
    });
    await client.callTool({ name: 'get_thread', arguments: { threadId: gmail } });
    await client.callTool({ name: 'get_thread', arguments: { threadId: refs } });
    expect(logs.map((l) => [l.account, l.id])).toEqual([
      ['a', gmail],
      ['b', null],
    ]);
  });

  it('logs no id for an invalid id', async () => {
    const client = await connect();
    await client.callTool({ name: 'get_message', arguments: { messageId: 'nope!' } });
    expect(logs[0]).toMatchObject({ tool: 'get_message', account: null, id: null });
  });

  it('reports invalid ids as tool errors', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'get_message',
      arguments: { messageId: 'nope!' },
    });
    expect(result.isError).toBe(true);
  });

  it('returns attachments as embedded resources', async () => {
    const client = await connect();
    const id = encodeMessageId({ account: 'a', mailbox: 'INBOX', uidValidity: '1', uid: 1 });
    const result = await client.callTool({
      name: 'download_attachment',
      arguments: { messageId: id, attachmentId: '2' },
    });
    expect(result.content).toEqual([
      expect.objectContaining({
        type: 'resource',
        resource: expect.objectContaining({
          mimeType: 'application/pdf',
          blob: Buffer.from('pdf').toString('base64'),
        }) as object,
      }),
      { type: 'text', text: 'File name: a.pdf' },
    ]);
  });
});
