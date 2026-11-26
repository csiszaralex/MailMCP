import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { MailError } from '../errors.js';
import { decodeMessageId, decodeThreadId } from '../ids.js';
import type { LogTarget } from '../log.js';
import { assertOwnAccount } from '../mail/ref-checks.js';
import type { DraftPatch, LabelAction, WriteTarget } from '../mail/write-types.js';
import {
  addressListSchema,
  attachmentsDescription,
  attachmentSchema,
  compositionFields,
  toComposition,
  toOutgoing,
  type CompositionInput,
} from './compose-schema.js';
import type { ToolDeps } from './read-tools.js';
import { jsonResult, toolRunner, UNTRUSTED_NOTE } from './result.js';
import {
  accountIdSchema,
  accountsAllowing,
  levelWriter,
  messageTarget,
  NO_TARGET,
  scopeHelpers,
  threadTarget,
  type ToolScope,
} from './scope.js';

// The draft-level tools (D15, D16, D22-D24): none sends mail or loses a message. update_draft
// replaces a draft with its new version; manage_label deletes only an empty label or folder.

const WRITE = { readOnlyHint: false, openWorldHint: true, destructiveHint: false } as const;

const targetFields = {
  messageId: z.string().optional().describe('One message. Give this or threadId.'),
  threadId: z
    .string()
    .optional()
    .describe('Every message of a conversation. Give this or messageId.'),
};

interface TargetArgs {
  messageId?: string | undefined;
  threadId?: string | undefined;
}

function writeTarget(args: TargetArgs): WriteTarget {
  const { messageId, threadId } = args;
  if (messageId !== undefined && threadId === undefined) {
    return { kind: 'message', ref: decodeMessageId(messageId) };
  }
  if (threadId !== undefined && messageId === undefined) {
    return { kind: 'thread', ref: decodeThreadId(threadId) };
  }
  throw new MailError('invalid_argument', 'Give exactly one of messageId or threadId.');
}

/** Log label of a messageId/threadId pair; nothing unless exactly one is given. */
function targetLabel(args: TargetArgs): LogTarget {
  if (args.messageId !== undefined && args.threadId === undefined) {
    return messageTarget(args.messageId);
  }
  if (args.threadId !== undefined && args.messageId === undefined) {
    return threadTarget(args.threadId);
  }
  return NO_TARGET;
}

/**
 * update_draft follows the connector: an omitted or empty field keeps the draft's value. Not
 * attachments: they go on as given, and ImapMailWriter.updateDraft refuses to drop them unasked.
 */
function draftPatch(args: {
  to?: string[] | undefined;
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject?: string | undefined;
  body?: string | undefined;
  htmlBody?: string | undefined;
  attachments?: z.infer<typeof attachmentSchema>[] | undefined;
}): DraftPatch {
  const patch: DraftPatch = {};
  if (args.attachments !== undefined) patch.attachments = toOutgoing(args.attachments);
  if (args.to !== undefined && args.to.length > 0) patch.to = args.to;
  if (args.cc !== undefined && args.cc.length > 0) patch.cc = args.cc;
  if (args.bcc !== undefined && args.bcc.length > 0) patch.bcc = args.bcc;
  if (args.subject !== undefined && args.subject !== '') patch.subject = args.subject;
  if (args.body !== undefined && args.body !== '') patch.body = args.body;
  if (args.htmlBody !== undefined && args.htmlBody !== '') patch.htmlBody = args.htmlBody;
  return patch;
}

function labelAction(args: {
  action: 'create' | 'rename' | 'delete';
  name: string;
  newName?: string | undefined;
}): LabelAction {
  if (args.action !== 'rename') return { action: args.action, name: args.name };
  if (args.newName === undefined) {
    throw new MailError('unsupported_query', 'A rename needs newName.');
  }
  return { action: 'rename', name: args.name, newName: args.newName };
}

export function registerWriteTools(server: McpServer, scope: ToolScope, deps: ToolDeps): void {
  const allowed = accountsAllowing(scope, 'draft');
  if (allowed.length === 0) return;
  const scoped = scope.scopedAccountId !== undefined;
  const { inScope, requestedAccount, onlyAccount } = scopeHelpers(scope);
  const writerOf = levelWriter(scope, deps, 'draft');
  const run = toolRunner(deps.log);
  const accountTarget = (requested: string | undefined): LogTarget => ({
    account: requestedAccount(requested),
    id: null,
  });

  // create_draft and manage_label name their account
  const draftFields = {
    ...compositionFields,
    replyToMessageId: z
      .string()
      .optional()
      .describe(
        'Message to reply to: the draft quotes it, threads with it and, without recipients, takes them from it.',
      ),
  };
  const createDraftMeta = {
    title: 'Create a draft',
    description: `Saves a new draft in the Drafts mailbox; nothing is sent. Returns its draftId and threadId. ${UNTRUSTED_NOTE}`,
    annotations: WRITE,
  };
  const handleCreateDraft = (
    args: CompositionInput & {
      replyToMessageId?: string | undefined;
      account?: string | undefined;
    },
  ) =>
    run('create_draft', accountTarget(args.account), async () => {
      const writer = writerOf(onlyAccount(args.account));
      const composition = toComposition(args);
      const replyTo =
        args.replyToMessageId === undefined ? undefined : decodeMessageId(args.replyToMessageId);
      // The reply id must be on this endpoint and of the draft's own account (D15).
      if (replyTo !== undefined) assertOwnAccount(writer.account, inScope(replyTo.account).id);
      return jsonResult(await writer.createDraft(composition, replyTo));
    });

  const labelFields = {
    action: z.enum(['create', 'rename', 'delete']),
    name: z
      .string()
      .min(1)
      .describe('Gmail label name, or folder path on other accounts, as list_labels shows it.'),
    newName: z.string().min(1).optional().describe('The new name; required for rename.'),
  };
  const labelMeta = {
    title: 'Create, rename or delete a label',
    description: `Creates, renames or deletes a Gmail label or, on other accounts, a folder. INBOX and special folders (Sent, Trash...) cannot be renamed or deleted. A label or folder can only be deleted when no message is in it (on Gmail, first remove the label from its messages with update_labels). ${UNTRUSTED_NOTE}`,
    annotations: { ...WRITE, destructiveHint: true },
  };
  const handleLabel = (args: {
    action: 'create' | 'rename' | 'delete';
    name: string;
    newName?: string | undefined;
    account?: string | undefined;
  }) =>
    // The label name stays out of the log.
    run('manage_label', accountTarget(args.account), async () => {
      const writer = writerOf(onlyAccount(args.account));
      await writer.manageLabel(labelAction(args));
      return jsonResult({ ok: true });
    });

  if (scoped) {
    server.registerTool(
      'create_draft',
      { ...createDraftMeta, inputSchema: z.object(draftFields) },
      handleCreateDraft,
    );
    server.registerTool(
      'manage_label',
      { ...labelMeta, inputSchema: z.object(labelFields) },
      handleLabel,
    );
  } else {
    const account = accountIdSchema(allowed);
    server.registerTool(
      'create_draft',
      { ...createDraftMeta, inputSchema: z.object({ ...draftFields, account }) },
      handleCreateDraft,
    );
    server.registerTool(
      'manage_label',
      { ...labelMeta, inputSchema: z.object({ ...labelFields, account }) },
      handleLabel,
    );
  }

  server.registerTool(
    'update_draft',
    {
      title: 'Update a draft',
      description: `Replaces the fields given; an omitted or empty field keeps the draft's value. body and htmlBody are replaced together: giving only body drops the draft's HTML version, giving only htmlBody drops its plain text. Attachments are the exception: given ones replace the draft's, and attachments: [] drops them. Omitting attachments on a draft that has some is refused, because the update would lose them: give them again or pass []. The draft is saved as a new version, so its id changes: use the new draftId from the answer. ${UNTRUSTED_NOTE}`,
      inputSchema: z.object({
        draftId: z.string().describe('Draft id from list_drafts or create_draft.'),
        to: addressListSchema.optional(),
        cc: addressListSchema.optional(),
        bcc: addressListSchema.optional(),
        subject: z.string().optional().describe('Subject line.'),
        body: compositionFields.body,
        htmlBody: compositionFields.htmlBody,
        attachments: z
          .array(attachmentSchema)
          .optional()
          .describe(`${attachmentsDescription} Replace the draft's attachments; [] drops them.`),
      }),
      annotations: WRITE,
    },
    (args) =>
      run('update_draft', messageTarget(args.draftId), async () => {
        const ref = decodeMessageId(args.draftId);
        return jsonResult(await writerOf(ref.account).updateDraft(ref, draftPatch(args)));
      }),
  );

  server.registerTool(
    'delete_draft',
    {
      title: 'Delete a draft',
      description: `Moves a draft to the trash (not a permanent delete; untrash restores it). Returns its id in the trash. ${UNTRUSTED_NOTE}`,
      inputSchema: z.object({ draftId: z.string().describe('Draft id from list_drafts.') }),
      annotations: WRITE,
    },
    (args) =>
      run('delete_draft', messageTarget(args.draftId), async () => {
        const ref = decodeMessageId(args.draftId);
        return jsonResult(await writerOf(ref.account).deleteDraft(ref));
      }),
  );

  server.registerTool(
    'update_labels',
    {
      title: 'Add or remove labels',
      description: `Adds and removes labels of a message or a whole conversation. UNREAD and STARRED set the read and star marks. On Gmail every other name is a label (the id stays). On other accounts a folder is a label: adding a folder moves the mail there, removing INBOX archives it, other combinations are refused; a move changes the ids, and the answer gives the new ones. Use trash and mark_spam for the trash and spam. ${UNTRUSTED_NOTE}`,
      inputSchema: z.object({
        ...targetFields,
        add: z.array(z.string()).default([]).describe('Label or folder names to add.'),
        remove: z.array(z.string()).default([]).describe('Label or folder names to remove.'),
      }),
      annotations: WRITE,
    },
    (args) =>
      run('update_labels', targetLabel(args), async () => {
        const target = writeTarget(args);
        const writer = writerOf(target.ref.account);
        return jsonResult(
          await writer.updateLabels(target, { add: args.add, remove: args.remove }),
        );
      }),
  );

  // ImapMailWriter restores to All Mail on Gmail (#restorePath), which does not add the inbox label.
  const GMAIL_RESTORE_NOTE =
    'On Gmail the mail keeps its labels but comes back without the inbox (Gmail drops the inbox label when mail goes to the trash or spam); add INBOX with update_labels to put it back in the inbox.';
  const moves = [
    {
      name: 'trash',
      title: 'Move to trash',
      description: 'Moves a message or a whole conversation to the trash (untrash restores it).',
      method: 'trash',
    },
    {
      name: 'untrash',
      title: 'Restore from trash',
      description: `Moves a message or conversation out of the trash: on other accounts to INBOX, on Gmail to All Mail. ${GMAIL_RESTORE_NOTE}`,
      method: 'untrash',
    },
    {
      name: 'mark_spam',
      title: 'Mark as spam',
      description: 'Moves a message or a whole conversation to the spam folder.',
      method: 'markSpam',
    },
    {
      name: 'unmark_spam',
      title: 'Not spam',
      description: `Moves a message or conversation out of spam: on other accounts to INBOX, on Gmail to All Mail. ${GMAIL_RESTORE_NOTE}`,
      method: 'unmarkSpam',
    },
  ] as const;
  for (const move of moves) {
    server.registerTool(
      move.name,
      {
        title: move.title,
        description: `${move.description} The moved mail gets new ids; the answer lists them. ${UNTRUSTED_NOTE}`,
        inputSchema: z.object(targetFields),
        annotations: WRITE,
      },
      (args) =>
        run(move.name, targetLabel(args), async () => {
          const target = writeTarget(args);
          const writer = writerOf(target.ref.account);
          return jsonResult(await writer[move.method](target));
        }),
    );
  }
}
