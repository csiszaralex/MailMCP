import * as z from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { searchAccounts } from '../aggregate/search.js';
import type { Account } from '../config/types.js';
import { MailError } from '../errors.js';
import { decodeCursor, decodeMessageId, decodeThreadId, encodeCursor } from '../ids.js';
import type { Logger, LogTarget } from '../log.js';
import { ATTACHMENT_LIMIT_BYTES, THREAD_MESSAGE_LIMIT } from '../mail/imap-provider.js';
import type { MailProvider, MessageSummary } from '../mail/types.js';
import { jsonResult, runTool, UNTRUSTED_NOTE } from './result.js';

export interface ToolScope {
  accounts: readonly Account[];
  /** Set on /mcp/<id>: the account parameter disappears and ids must belong to it. */
  scopedAccountId: string | undefined;
}

export interface ToolDeps {
  providerFor(accountId: string): MailProvider;
  log: Logger;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
/** Most messages per page of search and list_drafts (spec: at most 50 per page). */
export const PAGE_SIZE_LIMIT = 50;
const pageSizeSchema = z.int().min(1).max(PAGE_SIZE_LIMIT).default(20);
const viewSchema = z.enum(['ids', 'metadata', 'minimal']).default('minimal');
const formatSchema = z.enum(['metadata', 'plain', 'html', 'raw']).default('plain');
type View = z.infer<typeof viewSchema>;

function accountIdSchema(accounts: readonly Account[]) {
  const [first, ...rest] = accounts.map((a) => a.id);
  if (first === undefined) throw new Error('at least one account is required');
  return z.enum([first, ...rest]).describe('Account id from list_accounts.');
}

function shape(message: MessageSummary, view: View): object {
  if (view === 'ids')
    return { id: message.id, threadId: message.threadId, account: message.account };
  if (view === 'metadata') {
    return Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'subject'));
  }
  return message;
}

const NO_TARGET: LogTarget = { account: null, id: null };

/** Log label of a message id: its account and the opaque id; nothing for an invalid id. */
function messageTarget(messageId: string): LogTarget {
  try {
    return { account: decodeMessageId(messageId).account, id: messageId };
  } catch {
    return NO_TARGET;
  }
}

/** Log label of a thread id; a references thread id embeds a Message-ID header, so only its account. */
function threadTarget(threadId: string): LogTarget {
  try {
    const ref = decodeThreadId(threadId);
    return { account: ref.account, id: ref.kind === 'gmail' ? threadId : null };
  } catch {
    return NO_TARGET;
  }
}

export function registerReadTools(server: McpServer, scope: ToolScope, deps: ToolDeps): void {
  const scoped = scope.scopedAccountId !== undefined;
  const inScope = (accountId: string): Account => {
    const found = scope.accounts.find((a) => a.id === accountId);
    if (found === undefined) {
      throw new MailError(
        'unknown_account',
        `Account "${accountId}" is not available on this endpoint.`,
      );
    }
    return found;
  };
  const providerOf = (accountId: string): MailProvider => deps.providerFor(inScope(accountId).id);
  /** The account a single-account call targets, or null if none was given; never throws, so it is safe as a log label. */
  const requestedAccount = (requested: string | undefined): string | null =>
    scope.scopedAccountId ?? requested ?? null;
  const onlyAccount = (requested: string | undefined): string => {
    const id = requestedAccount(requested);
    if (id === null) throw new MailError('unknown_account', 'The account parameter is required.');
    return id;
  };
  const run = (tool: string, target: LogTarget, fn: () => Promise<CallToolResult>) =>
    runTool(deps.log, tool, target, fn);
  const accountTarget = (requested: string | undefined): LogTarget => ({
    account: requestedAccount(requested),
    id: null,
  });

  server.registerTool(
    'list_accounts',
    {
      title: 'List mail accounts',
      description: `Lists the mail accounts available on this endpoint with their access level. ${UNTRUSTED_NOTE}`,
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    () =>
      run('list_accounts', NO_TARGET, () =>
        Promise.resolve(
          jsonResult(
            scope.accounts.map((a) => ({
              id: a.id,
              address: a.address,
              provider: a.provider,
              level: a.level,
            })),
          ),
        ),
      ),
  );

  // search
  const searchFields = {
    query: z
      .string()
      .default('')
      .describe(
        'Gmail search syntax. Gmail accounts support all operators. Other accounts support from:, to:, cc:, subject:, after:YYYY/MM/DD, before:YYYY/MM/DD, is:unread|read|starred|unstarred, has:attachment, in:<mailbox> and free words (searched as one phrase), each operator once.',
      ),
    pageSize: pageSizeSchema,
    pageToken: z.string().optional().describe('nextPageToken from the previous call.'),
    view: viewSchema.describe('ids: only ids; metadata: no subject; minimal: everything.'),
  };
  const searchMeta = {
    title: 'Search mail',
    description: `Searches messages, newest first, across all accounts on this endpoint unless an account is given. Each result has a threadId for get_thread. ${UNTRUSTED_NOTE}`,
    annotations: READ_ONLY,
  };
  const handleSearch = (args: {
    query: string;
    pageSize: number;
    pageToken?: string | undefined;
    view: View;
    account?: string | undefined;
  }) =>
    run('search', accountTarget(args.account), async () => {
      const ids =
        args.account !== undefined || scoped
          ? [onlyAccount(args.account)]
          : scope.accounts.map((a) => a.id);
      const result = await searchAccounts(
        ids.map(providerOf),
        args.query,
        args.pageSize,
        args.pageToken,
      );
      return jsonResult({
        messages: result.messages.map((m) => shape(m, args.view)),
        nextPageToken: result.nextPageToken,
        errors: result.errors,
      });
    });
  if (scoped) {
    server.registerTool(
      'search',
      { ...searchMeta, inputSchema: z.object(searchFields) },
      handleSearch,
    );
  } else {
    server.registerTool(
      'search',
      {
        ...searchMeta,
        inputSchema: z.object({
          ...searchFields,
          account: accountIdSchema(scope.accounts).optional(),
        }),
      },
      handleSearch,
    );
  }

  server.registerTool(
    'get_message',
    {
      title: 'Get a message',
      description: `Returns one message with its attachment list. format: plain (default), html, metadata or raw. ${UNTRUSTED_NOTE}`,
      inputSchema: z.object({ messageId: z.string(), format: formatSchema }),
      annotations: READ_ONLY,
    },
    (args) =>
      run('get_message', messageTarget(args.messageId), async () => {
        const ref = decodeMessageId(args.messageId);
        return jsonResult(await providerOf(ref.account).getMessage(ref, args.format));
      }),
  );

  server.registerTool(
    'get_thread',
    {
      title: 'Get a conversation',
      description: `Returns the messages of a conversation in chronological order: the newest ${String(THREAD_MESSAGE_LIMIT)} at most, with olderOmitted counting the older ones left out. ${UNTRUSTED_NOTE}`,
      inputSchema: z.object({ threadId: z.string(), format: formatSchema }),
      annotations: READ_ONLY,
    },
    (args) =>
      run('get_thread', threadTarget(args.threadId), async () => {
        const ref = decodeThreadId(args.threadId);
        return jsonResult(await providerOf(ref.account).getThread(ref, args.format));
      }),
  );

  server.registerTool(
    'download_attachment',
    {
      title: 'Download an attachment',
      description: `Returns an attachment file (max ${String(ATTACHMENT_LIMIT_BYTES / (1024 * 1024))} MB). Take attachmentId from get_message. ${UNTRUSTED_NOTE}`,
      inputSchema: z.object({ messageId: z.string(), attachmentId: z.string() }),
      annotations: READ_ONLY,
    },
    (args) =>
      run('download_attachment', messageTarget(args.messageId), async () => {
        const ref = decodeMessageId(args.messageId);
        const file = await providerOf(ref.account).downloadAttachment(ref, args.attachmentId);
        return {
          content: [
            {
              type: 'resource',
              resource: {
                uri: `mailmcp://attachment/${encodeURIComponent(args.messageId)}/${encodeURIComponent(args.attachmentId)}`,
                mimeType: file.mimeType,
                blob: file.data.toString('base64'),
              },
            },
            { type: 'text', text: `File name: ${file.filename}` },
          ],
        };
      }),
  );

  // list_labels and list_drafts need one account
  const labelsMeta = {
    title: 'List labels and folders',
    description: `Lists Gmail labels or IMAP folders, with special-use flags such as \\Sent or \\Trash. ${UNTRUSTED_NOTE}`,
    annotations: READ_ONLY,
  };
  const handleLabels = (args: { account?: string | undefined }) =>
    run('list_labels', accountTarget(args.account), async () =>
      jsonResult(await providerOf(onlyAccount(args.account)).listLabels()),
    );

  const draftsFields = {
    pageSize: pageSizeSchema,
    pageToken: z.string().optional(),
  };
  const draftsMeta = {
    title: 'List drafts',
    description: `Lists draft messages, newest first. Read one with get_draft. ${UNTRUSTED_NOTE}`,
    annotations: READ_ONLY,
  };
  const handleDrafts = (args: {
    pageSize: number;
    pageToken?: string | undefined;
    account?: string | undefined;
  }) =>
    run('list_drafts', accountTarget(args.account), async () => {
      const id = onlyAccount(args.account);
      const offset = args.pageToken === undefined ? 0 : (decodeCursor(args.pageToken)[id] ?? 0);
      const page = await providerOf(id).listDrafts(offset, args.pageSize);
      const nextOffset = offset + page.messages.length;
      return jsonResult({
        drafts: page.messages,
        nextPageToken: nextOffset < page.total ? encodeCursor({ [id]: nextOffset }) : null,
      });
    });

  if (scoped) {
    server.registerTool('list_labels', { ...labelsMeta, inputSchema: z.object({}) }, handleLabels);
    server.registerTool(
      'list_drafts',
      { ...draftsMeta, inputSchema: z.object(draftsFields) },
      handleDrafts,
    );
  } else {
    const account = accountIdSchema(scope.accounts);
    server.registerTool(
      'list_labels',
      { ...labelsMeta, inputSchema: z.object({ account }) },
      handleLabels,
    );
    server.registerTool(
      'list_drafts',
      { ...draftsMeta, inputSchema: z.object({ ...draftsFields, account }) },
      handleDrafts,
    );
  }

  server.registerTool(
    'get_draft',
    {
      title: 'Get a draft',
      description: `Returns one draft (an id from list_drafts). ${UNTRUSTED_NOTE}`,
      inputSchema: z.object({ draftId: z.string(), format: formatSchema }),
      annotations: READ_ONLY,
    },
    (args) =>
      run('get_draft', messageTarget(args.draftId), async () => {
        const ref = decodeMessageId(args.draftId);
        return jsonResult(await providerOf(ref.account).getMessage(ref, args.format));
      }),
  );
}
