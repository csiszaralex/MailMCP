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
import { encodeMessageId, encodeThreadId } from '../../src/ids.js';
import { UNTRUSTED_NOTE } from '../../src/tools/result.js';
import { scopeHelpers } from '../../src/tools/scope.js';

const WRITE_TOOLS = [
  'create_draft',
  'delete_draft',
  'manage_label',
  'mark_spam',
  'trash',
  'unmark_spam',
  'untrash',
  'update_draft',
  'update_labels',
];

function acc(id: string, level: AccessLevel): Account {
  return { id, address: `${id}@example.org`, provider: 'imap', level } as Account;
}

const ACCOUNTS = [acc('a', 'read'), acc('b', 'draft'), acc('c', 'send')];

function idOf(account: string, uid = 1): string {
  return encodeMessageId({ account, mailbox: 'Drafts', uidValidity: '1', uid });
}

const writerCalls: { account: string; method: string; args: (object | undefined)[] }[] = [];
const logs: LogRecord[] = [];

function fakeWriter(account: Account): MailWriter {
  const record =
    (method: string) =>
    (...args: (object | undefined)[]) => {
      writerCalls.push({ account: account.id, method, args });
      return Promise.resolve({ draftId: idOf(account.id, 2), threadId: 't', warnings: [] });
    };
  const reject = () => Promise.reject(new Error('send tools are not part of this test'));
  return {
    account,
    createDraft: record('createDraft'),
    updateDraft: record('updateDraft'),
    deleteDraft: () => {
      writerCalls.push({ account: account.id, method: 'deleteDraft', args: [] });
      return Promise.resolve({ messageIds: [idOf(account.id, 9)], warnings: [] });
    },
    updateLabels: (...args) => {
      writerCalls.push({ account: account.id, method: 'updateLabels', args });
      return Promise.resolve({ messageIds: [], warnings: [] });
    },
    manageLabel: (...args) => {
      writerCalls.push({ account: account.id, method: 'manageLabel', args });
      return Promise.resolve();
    },
    trash: (...args) => {
      writerCalls.push({ account: account.id, method: 'trash', args });
      return Promise.resolve({ messageIds: [], warnings: [] });
    },
    untrash: (...args) => {
      writerCalls.push({ account: account.id, method: 'untrash', args });
      return Promise.resolve({ messageIds: [], warnings: [] });
    },
    markSpam: (...args) => {
      writerCalls.push({ account: account.id, method: 'markSpam', args });
      return Promise.resolve({ messageIds: [], warnings: [] });
    },
    unmarkSpam: (...args) => {
      writerCalls.push({ account: account.id, method: 'unmarkSpam', args });
      return Promise.resolve({ messageIds: [], warnings: [] });
    },
    send: reject,
    sendDraft: reject,
    reply: reject,
    forward: reject,
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

async function toolNames(scope?: ToolScope): Promise<string[]> {
  return (await listTools(scope)).map((t) => t.name);
}

function toolOf(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool;
}

/** The JSON Schema of one input parameter, or undefined if the tool has no such parameter. */
function paramOf(tools: Tool[], name: string, param: string): object | undefined {
  return toolOf(tools, name).inputSchema.properties?.[param] as object | undefined;
}

async function call(
  name: string,
  args: Record<string, string | object>,
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

describe('write tool list', () => {
  it('offers no write tools when every account is read-only', async () => {
    const names = await toolNames(scopeOf([acc('a', 'read')]));
    expect(names).not.toContain('create_draft');
    for (const name of WRITE_TOOLS) expect(names).not.toContain(name);
  });

  it('offers the draft-level tools when an account allows them', async () => {
    const names = await toolNames();
    for (const name of WRITE_TOOLS) expect(names).toContain(name);
  });

  it('offers draft tools and lists only accounts that allow them', async () => {
    const tools = await listTools(scopeOf([acc('a', 'read'), acc('b', 'draft')]));
    expect(paramOf(tools, 'create_draft', 'account')).toMatchObject({ enum: ['b'] });
    expect(paramOf(tools, 'manage_label', 'account')).toMatchObject({ enum: ['b'] });
    expect(paramOf(await listTools(), 'create_draft', 'account')).toMatchObject({
      enum: ['b', 'c'],
    });
  });

  it('drops the account parameter on a per-account endpoint', async () => {
    const tools = await listTools(scopeOf([acc('b', 'draft')], 'b'));
    for (const name of ['create_draft', 'manage_label']) {
      expect(Object.keys(toolOf(tools, name).inputSchema.properties ?? {}), name).not.toContain(
        'account',
      );
    }
  });

  it('adds the untrusted note to every write tool', async () => {
    const tools = await listTools();
    for (const name of WRITE_TOOLS) {
      expect(toolOf(tools, name).description?.endsWith(UNTRUSTED_NOTE), name).toBe(true);
    }
  });

  it('marks only manage_label as destructive', async () => {
    const tools = await listTools();
    for (const name of WRITE_TOOLS) {
      expect(toolOf(tools, name).annotations, name).toMatchObject({
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: name === 'manage_label',
      });
    }
  });

  it('states the attachment limit and the draft caveats', async () => {
    const tools = await listTools();
    const limit = `${String(OUTGOING_ATTACHMENTS_LIMIT_BYTES / (1024 * 1024))} MB`;
    const attachments = toolOf(tools, 'create_draft').inputSchema.properties?.attachments;
    expect(JSON.stringify(attachments)).toContain(limit);
    expect(JSON.stringify(attachments)).toContain('cid:att');
    const body = toolOf(tools, 'create_draft').inputSchema.properties?.body;
    expect(JSON.stringify(body)).toContain('Markdown');
    expect(toolOf(tools, 'delete_draft').description).toMatch(/trash/i);
    const update = toolOf(tools, 'update_draft').description ?? '';
    expect(update).toMatch(/id changes/i);
    // ImapMailWriter.updateDraft refuses an update that omits the draft's attachments.
    expect(update).toContain('attachments: [] drops them');
    // ImapMailWriter.updateDraft replaces body and htmlBody together.
    expect(update).toContain("giving only body drops the draft's HTML version");
  });

  it('says how a restored Gmail message gets back to the inbox', async () => {
    const tools = await listTools();
    for (const name of ['untrash', 'unmark_spam']) {
      const description = toolOf(tools, name).description ?? '';
      // ImapMailWriter restores to All Mail on Gmail (restorePath), not to the inbox.
      expect(description, name).toContain(
        'On Gmail the message returns to All Mail with its labels; if it is not in the inbox afterwards, add INBOX with update_labels.',
      );
      // Unmeasured for spam: no claim that Gmail removes the inbox label.
      expect(description, name).not.toMatch(/drops|removes/);
    }
  });
});

describe('write tool calls', () => {
  it('refuses an id of a read-only account with not_permitted', async () => {
    const res = await call('trash', { messageId: idOf('a') });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('not_permitted');
    expect(writerCalls).toEqual([]);
  });

  it('checks the endpoint scope before the level', async () => {
    const res = await call('trash', { messageId: idOf('a') }, scopeOf([acc('b', 'draft')], 'b'));
    expect(textOf(res)).toContain('unknown_account');
    expect(writerCalls).toEqual([]);
  });

  it('needs exactly one of messageId and threadId', async () => {
    const thread = encodeThreadId({ kind: 'gmail', account: 'b', gmailThreadId: '1' });
    for (const args of [{}, { messageId: idOf('b'), threadId: thread }]) {
      const res = await call('untrash', args);
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe('invalid_argument: Give exactly one of messageId or threadId.');
    }
    expect(writerCalls).toEqual([]);
  });

  it('passes a message or a thread target to the writer', async () => {
    const thread = encodeThreadId({ kind: 'gmail', account: 'c', gmailThreadId: '17' });
    await call('mark_spam', { messageId: idOf('b') });
    await call('unmark_spam', { threadId: thread });
    await call('update_labels', { messageId: idOf('b'), add: ['STARRED'] });
    expect(writerCalls).toEqual([
      {
        account: 'b',
        method: 'markSpam',
        args: [
          { kind: 'message', ref: expect.objectContaining({ account: 'b', uid: 1 }) as object },
        ],
      },
      {
        account: 'c',
        method: 'unmarkSpam',
        args: [{ kind: 'thread', ref: { kind: 'gmail', account: 'c', gmailThreadId: '17' } }],
      },
      {
        account: 'b',
        method: 'updateLabels',
        args: [
          expect.objectContaining({ kind: 'message' }) as object,
          { add: ['STARRED'], remove: [] },
        ],
      },
    ]);
  });

  it('creates a draft with the connector defaults', async () => {
    const res = await call('create_draft', { account: 'b', to: ['bob@example.org'] });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toMatchObject({ draftId: idOf('b', 2) });
    expect(writerCalls).toEqual([
      {
        account: 'b',
        method: 'createDraft',
        args: [
          {
            to: ['bob@example.org'],
            cc: [],
            bcc: [],
            subject: '',
            body: undefined,
            htmlBody: undefined,
            attachments: [],
            includeSignature: false,
          },
          undefined,
        ],
      },
    ]);
  });

  it('creates a reply draft and an inline attachment', async () => {
    const original = encodeMessageId({ account: 'b', mailbox: 'INBOX', uidValidity: '1', uid: 5 });
    await call(
      'create_draft',
      {
        replyToMessageId: original,
        htmlBody: '<img src="cid:att0">',
        attachments: [{ content: 'aGk=', mimeType: 'image/png', inline: true }],
      },
      scopeOf([acc('b', 'draft')], 'b'),
    );
    expect(writerCalls[0]?.args).toEqual([
      expect.objectContaining({
        attachments: [
          { content: 'aGk=', filename: undefined, mimeType: 'image/png', inline: true },
        ],
      }),
      { account: 'b', mailbox: 'INBOX', uidValidity: '1', uid: 5 },
    ]);
  });

  it('refuses a reply to a message of another account', async () => {
    const ofC = encodeMessageId({ account: 'c', mailbox: 'INBOX', uidValidity: '1', uid: 5 });
    const foreign = await call('create_draft', { account: 'b', replyToMessageId: ofC });
    expect(textOf(foreign)).toBe('invalid_argument: This id belongs to account "c", not "b".');
    const ofA = encodeMessageId({ account: 'a', mailbox: 'INBOX', uidValidity: '1', uid: 5 });
    const outOfScope = await call(
      'create_draft',
      { replyToMessageId: ofA },
      scopeOf([acc('b', 'draft')], 'b'),
    );
    expect(textOf(outOfScope)).toBe(
      'unknown_account: Account "a" is not available on this endpoint.',
    );
    expect(writerCalls).toEqual([]);
  });

  it('rejects an invalid address or base64 content before the writer', async () => {
    const bad = await call('create_draft', { account: 'b', to: ['not an address'] });
    const badFile = await call('create_draft', {
      account: 'b',
      attachments: [{ content: 'not base64!' }],
    });
    expect(bad.isError).toBe(true);
    expect(badFile.isError).toBe(true);
    expect(writerCalls).toEqual([]);
  });

  it('updates only the given fields of a draft', async () => {
    const res = await call('update_draft', {
      draftId: idOf('b'),
      subject: 'New',
      cc: [],
      body: '',
    });
    expect(JSON.parse(textOf(res))).toMatchObject({ draftId: idOf('b', 2) });
    expect(writerCalls).toEqual([
      {
        account: 'b',
        method: 'updateDraft',
        args: [expect.objectContaining({ uid: 1 }) as object, { subject: 'New' }],
      },
    ]);
  });

  it('passes an empty attachment list on, so the writer drops the attachments', async () => {
    await call('update_draft', { draftId: idOf('b'), subject: 'New', attachments: [] });
    expect(writerCalls).toEqual([
      {
        account: 'b',
        method: 'updateDraft',
        args: [expect.objectContaining({ uid: 1 }) as object, { subject: 'New', attachments: [] }],
      },
    ]);
  });

  it('refuses a draft update on a read-only account', async () => {
    const res = await call('update_draft', { draftId: idOf('a'), subject: 'x' });
    expect(textOf(res)).toContain('not_permitted');
    const del = await call('delete_draft', { draftId: idOf('a') });
    expect(textOf(del)).toContain('not_permitted');
    expect(writerCalls).toEqual([]);
  });

  it('deletes a draft into the trash and returns the moved ids', async () => {
    const res = await call('delete_draft', { draftId: idOf('c') });
    expect(JSON.parse(textOf(res))).toEqual({ messageIds: [idOf('c', 9)], warnings: [] });
  });

  it('manages labels and requires newName for a rename', async () => {
    await call('manage_label', { account: 'b', action: 'rename', name: 'Old', newName: 'New' });
    await call('manage_label', { account: 'c', action: 'delete', name: 'Gone' });
    const missing = await call('manage_label', { account: 'b', action: 'rename', name: 'Old' });
    expect(textOf(missing)).toBe('invalid_argument: A rename needs newName.');
    expect(writerCalls).toEqual([
      {
        account: 'b',
        method: 'manageLabel',
        args: [{ action: 'rename', name: 'Old', newName: 'New' }],
      },
      { account: 'c', method: 'manageLabel', args: [{ action: 'delete', name: 'Gone' }] },
    ]);
  });

  it('reports a missing account as invalid_argument', () => {
    // The tool schemas require the account on the all-accounts endpoint; onlyAccount is the backstop.
    const call = (): string => scopeHelpers(scopeOf(ACCOUNTS)).onlyAccount(undefined);
    expect(call).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    expect(call).toThrow('The account parameter is required.');
  });

  it('refuses manage_label for an account outside the allowed ones', async () => {
    const res = await call('manage_label', { account: 'a', action: 'create', name: 'X' });
    expect(res.isError).toBe(true);
    expect(writerCalls).toEqual([]);
  });

  it('logs account and id but no recipient, subject or label name', async () => {
    await call('create_draft', { account: 'b', to: ['bob@example.org'], subject: 'Secret plan' });
    await call('manage_label', { account: 'b', action: 'create', name: 'Secret label' });
    await call('trash', { messageId: idOf('b') });
    expect(JSON.stringify(logs)).not.toMatch(/bob@example\.org|Secret plan|Secret label/);
    expect(logs.map((l) => [l.tool, l.account, l.id])).toEqual([
      ['create_draft', 'b', null],
      ['manage_label', 'b', null],
      ['trash', 'b', idOf('b')],
    ]);
  });

  it('logs no id for a thread id that embeds a Message-ID', async () => {
    const refs = encodeThreadId({
      kind: 'references',
      account: 'b',
      mailbox: 'INBOX',
      rootMessageId: '<root@example.org>',
    });
    await call('trash', { threadId: refs });
    expect(logs[0]).toMatchObject({ tool: 'trash', account: 'b', id: null });
    expect(JSON.stringify(logs)).not.toContain('root@example.org');
  });
});
