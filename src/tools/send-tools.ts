import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { MailError } from '../errors.js';
import { decodeMessageId } from '../ids.js';
import { assertOwnAccount } from '../mail/ref-checks.js';
import {
  addressListSchema,
  ATTACHMENT_LIMIT_MB,
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
  scopeHelpers,
  type ToolScope,
} from './scope.js';

// The send-level tools (D15, D18, D19, D21): the mail leaves at once and cannot be recalled.

const SEND = { readOnlyHint: false, openWorldHint: true, destructiveHint: true } as const;

const IMMEDIATE = 'The mail is sent immediately and cannot be recalled.';

const RETURNS =
  'Returns the Message-ID header, the to, cc and bcc addresses it went to, the id of the copy in the Sent folder (null on Gmail, which keeps its own) and any warnings.';

const messageIdField = (what: string) =>
  z.string().describe(`Id of the message to ${what}, from search or read_message.`);

const nonEmpty = (list: string[] | undefined): string[] | undefined =>
  list === undefined || list.length === 0 ? undefined : list;

export function registerSendTools(server: McpServer, scope: ToolScope, deps: ToolDeps): void {
  const allowed = accountsAllowing(scope, 'send');
  if (allowed.length === 0) return;
  const scoped = scope.scopedAccountId !== undefined;
  const { inScope, requestedAccount } = scopeHelpers(scope);
  const writerOf = levelWriter(scope, deps, 'send');
  const run = toolRunner(deps.log);

  // send: a new mail, or a saved draft (draftId)
  const sendFields = {
    ...compositionFields,
    draftId: z
      .string()
      .optional()
      .describe(
        'Send this saved draft as it is, instead of composing a new mail; give no other content field with it. Draft id from list_drafts or create_draft.',
      ),
  };
  const sendMeta = {
    title: 'Send an email',
    description: `Sends a new mail, or with draftId a saved draft. ${IMMEDIATE} A new mail needs at least one recipient (to, cc or bcc). Attachments together at most ${ATTACHMENT_LIMIT_MB} MB decoded. ${RETURNS} ${UNTRUSTED_NOTE}`,
    annotations: SEND,
  };
  const handleSend = (
    args: CompositionInput & { draftId?: string | undefined; account?: string | undefined },
  ) =>
    run(
      'send',
      args.draftId === undefined
        ? { account: requestedAccount(args.account), id: null }
        : messageTarget(args.draftId),
      async () => {
        // The chosen account (if any) is checked first, like any other id of an endpoint.
        const chosen = args.account === undefined ? undefined : inScope(args.account);
        if (args.draftId !== undefined) {
          const hasContent =
            args.to.length > 0 ||
            args.cc.length > 0 ||
            args.bcc.length > 0 ||
            args.subject !== '' ||
            args.body !== undefined ||
            args.htmlBody !== undefined ||
            args.attachments.length > 0 ||
            args.includeSignature;
          if (hasContent) {
            throw new MailError(
              'invalid_id',
              'With draftId the draft is sent as it is; leave the other fields out.',
            );
          }
          const ref = decodeMessageId(args.draftId);
          if (chosen !== undefined) assertOwnAccount(chosen, ref.account);
          return jsonResult(await writerOf(ref.account).sendDraft(ref));
        }
        if (args.to.length + args.cc.length + args.bcc.length === 0) {
          throw new MailError(
            'unsupported_query',
            'Give at least one recipient (to, cc or bcc), or a draftId.',
          );
        }
        const accountId = chosen?.id ?? scope.scopedAccountId;
        if (accountId === undefined) {
          throw new MailError('unknown_account', 'The account parameter is required.');
        }
        return jsonResult(await writerOf(accountId).send(toComposition(args)));
      },
    );

  if (scoped) {
    server.registerTool('send', { ...sendMeta, inputSchema: z.object(sendFields) }, handleSend);
  } else {
    const account = accountIdSchema(allowed);
    server.registerTool(
      'send',
      {
        ...sendMeta,
        inputSchema: z.object({
          ...sendFields,
          account: account
            .describe(
              `${account.description ?? ''} Required for a new mail; with draftId it must match the draft's account.`,
            )
            .optional(),
        }),
      },
      handleSend,
    );
  }

  server.registerTool(
    'reply',
    {
      title: 'Reply to an email',
      description: `Replies to a message in its conversation: threading headers, a "Re:" subject and the original quoted. Without to and cc the recipients are the Reply-To or From address of the original (the original's recipients if you sent it); replyAll adds its To and Cc addresses, without your own. get_message shows replyTo (empty when replies go to From), so you can check where a reply goes before sending it. ${IMMEDIATE} Attachments together at most ${ATTACHMENT_LIMIT_MB} MB decoded. ${RETURNS} ${UNTRUSTED_NOTE}`,
      inputSchema: z.object({
        messageId: messageIdField('reply to'),
        body: compositionFields.body,
        htmlBody: compositionFields.htmlBody,
        replyAll: z.boolean().default(false).describe('Also reply to the original To and Cc.'),
        to: addressListSchema.optional().describe('Replaces the computed To recipients.'),
        cc: addressListSchema.optional().describe('Replaces the computed Cc recipients.'),
        bcc: addressListSchema.default([]).describe('Blind carbon copy recipients.'),
        attachments: compositionFields.attachments,
        includeSignature: compositionFields.includeSignature,
      }),
      annotations: SEND,
    },
    (args) =>
      run('reply', messageTarget(args.messageId), async () => {
        const ref = decodeMessageId(args.messageId);
        const writer = writerOf(ref.account);
        return jsonResult(
          await writer.reply(ref, {
            body: args.body,
            htmlBody: args.htmlBody,
            attachments: toOutgoing(args.attachments),
            includeSignature: args.includeSignature,
            replyAll: args.replyAll,
            to: nonEmpty(args.to),
            cc: nonEmpty(args.cc),
            bcc: args.bcc,
          }),
        );
      }),
  );

  server.registerTool(
    'forward',
    {
      title: 'Forward an email',
      description: `Forwards a message: your note first, then a "Forwarded message" header block (From, Date, Subject, To) and the original text, with a "Fwd:" subject. The original's attachments go along; they count towards the limit of ${ATTACHMENT_LIMIT_MB} MB together with the attachments you add. ${IMMEDIATE} ${RETURNS} ${UNTRUSTED_NOTE}`,
      inputSchema: z.object({
        messageId: messageIdField('forward'),
        to: addressListSchema.min(1).describe('Primary recipients; at least one email address.'),
        cc: compositionFields.cc,
        bcc: compositionFields.bcc,
        forwardText: z.string().optional().describe('Your note above the forwarded message.'),
        htmlBody: compositionFields.htmlBody,
        attachments: z
          .array(attachmentSchema)
          .default([])
          .describe(`${attachmentsDescription} Added to the original's attachments.`),
        includeSignature: compositionFields.includeSignature,
      }),
      annotations: SEND,
    },
    (args) =>
      run('forward', messageTarget(args.messageId), async () => {
        const ref = decodeMessageId(args.messageId);
        const writer = writerOf(ref.account);
        return jsonResult(
          await writer.forward(ref, {
            to: args.to,
            cc: args.cc,
            bcc: args.bcc,
            forwardText: args.forwardText,
            htmlBody: args.htmlBody,
            attachments: toOutgoing(args.attachments),
            includeSignature: args.includeSignature,
          }),
        );
      }),
  );
}
