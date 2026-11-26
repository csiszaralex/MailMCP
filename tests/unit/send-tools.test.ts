import { afterEach, describe, expect, it } from 'vitest';
import {
  Client,
  InMemoryTransport,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/client';
import { buildMcpServer, type ToolDeps, type ToolScope } from '../../src/server.js';
import type { AccessLevel, Account } from '../../src/config/types.js';
import type { LogRecord } from '../../src/log.js';
import type { MailProvider } from '../../src/mail/types.js';
import type { MailWriter } from '../../src/mail/write-types.js';
import { OUTGOING_ATTACHMENTS_LIMIT_BYTES } from '../../src/mail/compose.js';
import { encodeMessageId } from '../../src/ids.js';
import { UNTRUSTED_NOTE } from '../../src/tools/result.js';

const SEND_TOOLS = ['forward', 'reply', 'send'];

function acc(id: string, level: AccessLevel): Account {
  return { id, address: `${id}@example.org`, provider: 'imap', level } as Account;
}

const ACCOUNTS = [acc('a', 'read'), acc('b', 'draft'), acc('c', 'send')];

function idOf(account: string, uid = 1): string {
  return encodeMessageId({ account, mailbox: 'INBOX', uidValidity: '1', uid });
}

const writerCalls: { account: string; method: string; args: (object | undefined)[] }[] = [];
const logs: LogRecord[] = [];

function fakeWriter(account: Account): MailWriter {
  const sent =
    (method: string) =>
    (...args: (object | undefined)[]) => {
      writerCalls.push({ account: account.id, method, args });
      return Promise.resolve({
        messageIdHeader: '<m@example.org>',
        to: ['bob@example.org'],
        cc: [],
        bcc: [],
        sentCopyId: null,
        warnings: [],
      });
    };
  const reject = () => Promise.reject(new Error('draft tools are not part of this test'));
  return {
    account,
    createDraft: reject,
    updateDraft: reject,
    deleteDraft: reject,
    updateLabels: reject,
    manageLabel: reject,
    trash: reject,
    untrash: reject,
    markSpam: reject,
    unmarkSpam: reject,
    send: sent('send'),
    sendDraft: sent('sendDraft'),
    reply: sent('reply'),
    forward: sent('forward'),
  };
}

const deps: ToolDeps = {
  providerFor: (id) =>
    ({ account: ACCOUNTS.find((a) => a.id === id) }) as Partial<MailProvider> as MailProvider,
  writerFor: (id) => fakeWriter(ACCOUNTS.find((a) => a.id === id) ?? acc(id, 'read')),
  log: (record) => logs.push(record),
};

const clients: Client[] = [];

function scopeOf(accounts: Account[], scopedAccountId?: string): ToolScope {
  return { accounts, scopedAccountId };
}

async function connect(scope: ToolScope = scopeOf(ACCOUNTS)): Promise<Client> {
  const server = buildMcpServer(scope, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

async function listTools(scope?: ToolScope): Promise<Tool[]> {
  return (await (await connect(scope)).listTools()).tools;
}

function toolOf(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool;
}

async function call(
  name: string,
  args: Record<string, string | boolean | object>,
  scope?: ToolScope,
): Promise<CallToolResult> {
  return (await connect(scope)).callTool({ name, arguments: args });
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === 'text' ? first.text : '';
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  logs.length = 0;
  writerCalls.length = 0;
});

describe('send tool list', () => {
  it('offers send tools only for send-level accounts', async () => {
    const lower = (await listTools(scopeOf([acc('a', 'read'), acc('b', 'draft')]))).map(
      (t) => t.name,
    );
    for (const name of SEND_TOOLS) expect(lower).not.toContain(name);
    const tools = await listTools();
    for (const name of SEND_TOOLS) expect(tools.map((t) => t.name)).toContain(name);
    expect(toolOf(tools, 'send').inputSchema.properties?.account).toMatchObject({
      enum: ['c'],
      description: expect.stringContaining('Account id from list_accounts.') as string,
    });
  });

  it('drops the account parameter on a per-account endpoint', async () => {
    const tools = await listTools(scopeOf([acc('c', 'send')], 'c'));
    for (const name of SEND_TOOLS) {
      expect(Object.keys(toolOf(tools, name).inputSchema.properties ?? {}), name).not.toContain(
        'account',
      );
    }
  });

  it('warns that the mail goes out at once and ends with the untrusted note', async () => {
    const tools = await listTools();
    for (const name of SEND_TOOLS) {
      const tool = toolOf(tools, name);
      expect(tool.description?.endsWith(UNTRUSTED_NOTE), name).toBe(true);
      expect(tool.description, name).toMatch(/immediately/);
      expect(tool.description, name).toMatch(/cannot be recalled/);
      expect(tool.annotations, name).toMatchObject({
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      });
    }
  });

  it('states the attachment limit', async () => {
    const limit = `${String(OUTGOING_ATTACHMENTS_LIMIT_BYTES / (1024 * 1024))} MB`;
    const tools = await listTools();
    for (const name of SEND_TOOLS) {
      expect(
        JSON.stringify(toolOf(tools, name).inputSchema.properties?.attachments),
        name,
      ).toContain(limit);
    }
  });
});

describe('send', () => {
  it('sends a new mail with the connector defaults', async () => {
    const res = await call('send', { account: 'c', to: ['bob@example.org'], subject: 'Hi' });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({
      messageIdHeader: '<m@example.org>',
      to: ['bob@example.org'],
      cc: [],
      bcc: [],
      sentCopyId: null,
      warnings: [],
    });
    expect(writerCalls).toEqual([
      {
        account: 'c',
        method: 'send',
        args: [
          {
            to: ['bob@example.org'],
            cc: [],
            bcc: [],
            subject: 'Hi',
            body: undefined,
            htmlBody: undefined,
            attachments: [],
            includeSignature: false,
          },
        ],
      },
    ]);
  });

  it('sends a new mail from the account of a per-account endpoint', async () => {
    // createApp builds /mcp/<id> with exactly this scope.
    const res = await call(
      'send',
      { to: ['bob@example.org'], subject: 'Hi' },
      scopeOf([acc('c', 'send')], 'c'),
    );
    expect(res.isError).toBeFalsy();
    expect(writerCalls).toEqual([
      {
        account: 'c',
        method: 'send',
        args: [expect.objectContaining({ to: ['bob@example.org'], subject: 'Hi' }) as object],
      },
    ]);
    expect(logs.map((l) => [l.tool, l.account])).toEqual([['send', 'c']]);
  });

  it('needs a recipient', async () => {
    const res = await call('send', { account: 'c', subject: 'Hi', body: 'x' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(
      'invalid_argument: Give at least one recipient (to, cc or bcc), or a draftId.',
    );
    expect(writerCalls).toEqual([]);
  });

  it('accepts a Bcc-only mail', async () => {
    const res = await call('send', { account: 'c', bcc: ['bob@example.org'] });
    expect(res.isError).toBeFalsy();
    expect(writerCalls.map((c) => c.method)).toEqual(['send']);
  });

  it('refuses an account below send', async () => {
    const res = await call('send', { account: 'b', to: ['bob@example.org'] }, scopeOf(ACCOUNTS));
    expect(res.isError).toBe(true);
    expect(writerCalls).toEqual([]);
  });

  it('needs the account parameter for a new mail on the all-accounts endpoint', async () => {
    const res = await call('send', { to: ['bob@example.org'] });
    expect(textOf(res)).toBe('invalid_argument: The account parameter is required.');
    expect(writerCalls).toEqual([]);
  });

  it('sends a draft as it is', async () => {
    const draft = idOf('c', 4);
    const mixed = await call('send', { draftId: draft, subject: 'other' });
    expect(mixed.isError).toBe(true);
    expect(textOf(mixed)).toBe(
      'invalid_argument: With draftId the draft is sent as it is; leave the other fields out.',
    );
    expect(writerCalls).toEqual([]);
    const res = await call('send', { draftId: draft });
    expect(res.isError).toBeFalsy();
    expect(writerCalls).toEqual([
      {
        account: 'c',
        method: 'sendDraft',
        args: [{ account: 'c', mailbox: 'INBOX', uidValidity: '1', uid: 4 }],
      },
    ]);
  });

  it('refuses a draft of a draft-level or an out-of-scope account', async () => {
    const level = await call('send', { draftId: idOf('b') });
    expect(textOf(level)).toContain('not_permitted');
    const scope = await call('send', { draftId: idOf('b') }, scopeOf([acc('c', 'send')], 'c'));
    expect(textOf(scope)).toContain('unknown_account');
    expect(writerCalls).toEqual([]);
  });

  it('refuses a draft of another account than the chosen one', async () => {
    const other = acc('d', 'send');
    const res = await call(
      'send',
      { account: 'c', draftId: idOf('d') },
      scopeOf([...ACCOUNTS, other]),
    );
    expect(textOf(res)).toBe('invalid_argument: This id belongs to account "d", not "c".');
    expect(writerCalls).toEqual([]);
  });

  it('logs the account and draft id but no recipients or subject', async () => {
    await call('send', { account: 'c', to: ['secret@example.org'], subject: 'Confidential' });
    await call('send', { draftId: idOf('c', 4) });
    expect(JSON.stringify(logs)).not.toContain('secret@example.org');
    expect(JSON.stringify(logs)).not.toContain('Confidential');
    expect(logs.map((l) => l.account)).toEqual(['c', 'c']);
  });
});

describe('reply', () => {
  it('passes the reply options to the writer', async () => {
    const res = await call('reply', {
      messageId: idOf('c', 7),
      body: 'Thanks',
      replyAll: true,
      bcc: ['audit@example.org'],
    });
    expect(res.isError).toBeFalsy();
    expect(writerCalls).toEqual([
      {
        account: 'c',
        method: 'reply',
        args: [
          { account: 'c', mailbox: 'INBOX', uidValidity: '1', uid: 7 },
          {
            body: 'Thanks',
            htmlBody: undefined,
            attachments: [],
            includeSignature: false,
            replyAll: true,
            to: undefined,
            cc: undefined,
            bcc: ['audit@example.org'],
          },
        ],
      },
    ]);
  });

  it('refuses a reply to a message of a draft-level account', async () => {
    const res = await call('reply', { messageId: idOf('b'), body: 'x' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('not_permitted');
    expect(writerCalls).toEqual([]);
  });

  it('refuses a message outside the endpoint', async () => {
    const res = await call(
      'reply',
      { messageId: idOf('b'), body: 'x' },
      scopeOf([acc('c', 'send')], 'c'),
    );
    expect(textOf(res)).toContain('unknown_account');
    expect(writerCalls).toEqual([]);
  });

  it('logs the message id but not the body', async () => {
    await call('reply', { messageId: idOf('c', 7), body: 'private words' });
    expect(logs[0]).toMatchObject({ account: 'c', id: idOf('c', 7) });
    expect(JSON.stringify(logs)).not.toContain('private words');
  });
});

describe('forward', () => {
  it('passes the forward options to the writer', async () => {
    await call('forward', {
      messageId: idOf('c', 8),
      to: ['bob@example.org'],
      forwardText: 'FYI',
    });
    expect(writerCalls).toEqual([
      {
        account: 'c',
        method: 'forward',
        args: [
          { account: 'c', mailbox: 'INBOX', uidValidity: '1', uid: 8 },
          {
            to: ['bob@example.org'],
            cc: [],
            bcc: [],
            forwardText: 'FYI',
            htmlBody: undefined,
            attachments: [],
            includeSignature: false,
          },
        ],
      },
    ]);
  });

  it('needs a primary recipient', async () => {
    const res = await call('forward', { messageId: idOf('c', 8) });
    expect(res.isError).toBe(true);
    expect(writerCalls).toEqual([]);
  });

  it('refuses a message of a draft-level account', async () => {
    const res = await call('forward', { messageId: idOf('b'), to: ['bob@example.org'] });
    expect(textOf(res)).toContain('not_permitted');
    expect(writerCalls).toEqual([]);
  });
});
