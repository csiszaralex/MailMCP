import type { Account } from '../config/types.js';
import { MailError } from '../errors.js';
import { encodeMessageId, type MessageRef } from '../ids.js';
import type { ImapClient } from '../imap/client.js';
import { resolveMailbox } from '../imap/mailboxes.js';
import { requireCapability, unknownMailbox, withMailbox } from '../imap/mailbox-lock.js';
import type { ImapPool } from '../imap/pool.js';
import type { SpecialUse } from '../search/query.js';
import type { SmtpSend } from '../smtp/sender.js';
import { sortedUids } from './imap-provider.js';
import {
  ARCHIVE,
  flagChange,
  folderDestination,
  gmailLabelChange,
  type FlagChange,
} from './label-plan.js';
import { buildMime, decodeAttachments, type MimeSpec } from './compose.js';
import { messageThreadId, referenceIds, threadIdFields } from './message-parts.js';
import {
  accountSpec,
  envelopeFor,
  forwardSpec,
  plainAddresses,
  quotedOriginal,
  replyBody,
  replyContext,
  replySpec,
  sendSpec,
  signedBody,
  type ReplyContext,
} from './outgoing.js';
import { assertCurrent, assertOwnAccount, messageGone } from './ref-checks.js';
import { readStored } from './stored.js';
import { threadLocation } from './thread-locate.js';
import type { Address, MailProvider } from './types.js';
import type {
  Composition,
  DraftOutcome,
  DraftPatch,
  ForwardInput,
  LabelAction,
  LabelChange,
  MailWriter,
  MoveOutcome,
  ReplyInput,
  SendOutcome,
  WriteTarget,
} from './write-types.js';

export const OLD_DRAFT_KEPT_WARNING =
  'The previous version of the draft could not be removed; delete it with delete_draft.';

export const SENT_COPY_FAILED_WARNING =
  'The message was sent, but its copy could not be stored in the Sent mailbox.';

export const SENT_COPY_WITHOUT_ID_WARNING =
  'The message was sent and copied to the Sent mailbox, but the server reported no id for the copy.';

export const SENT_DRAFT_KEPT_WARNING =
  'The message was sent, but the draft could not be removed; delete it with delete_draft.';

/** The server accepted the message for some recipients and refused these, who get nothing. */
export function rejectedRecipientsWarning(addresses: string[]): string {
  return `The message was sent, but the mail server rejected these recipients, who will not receive it: ${addresses.join(', ')}.`;
}

const DRAFT_FLAGS = ['\\Draft', '\\Seen'];

/** Where untrash and unmark_spam move to: All Mail on Gmail, INBOX elsewhere (D24). */
const RESTORE = Symbol('restore');

/** The message an untrash or unmark_spam id must be in, and the hint when it is not. */
const RESTORE_SOURCES = {
  '\\Trash': 'This message is not in the trash; search in:trash for its current id.',
  '\\Junk': 'This message is not in spam; search in:spam for its current id.',
} as const;

export class ImapMailWriter implements MailWriter {
  constructor(
    readonly account: Account,
    private readonly pool: ImapPool,
    private readonly reader: MailProvider,
    private readonly smtp: SmtpSend,
  ) {}

  async createDraft(c: Composition, replyTo: MessageRef | undefined): Promise<DraftOutcome> {
    const reply =
      replyTo === undefined
        ? undefined
        : await this.#replyContext(replyTo, c.htmlBody !== undefined, false);
    // R2: a reply draft without any recipient takes them from the original.
    const recipients =
      reply !== undefined && c.to.length + c.cc.length + c.bcc.length === 0
        ? { to: reply.to, cc: reply.cc }
        : { to: plainAddresses(c.to), cc: plainAddresses(c.cc) };
    const body =
      reply === undefined
        ? signedBody(this.account, c.body, c.htmlBody, c.includeSignature)
        : replyBody(this.account, reply, c.body, c.htmlBody, c.includeSignature);
    const raw = await buildMime(
      accountSpec(this.account, {
        ...recipients,
        bcc: plainAddresses(c.bcc),
        subject: c.subject === '' && reply !== undefined ? reply.subject : c.subject,
        text: body.text,
        html: body.html,
        attachments: decodeAttachments(c.attachments),
        inReplyTo: reply?.inReplyTo,
        references: reply?.references ?? [],
      }),
      { keepBcc: true },
    );
    return this.pool.use(this.account, async (client) => {
      const path = await this.#draftsPath(client);
      return withMailbox(client, path, { access: 'write', from: 'query' }, async (uidValidity) => {
        // Without UIDPLUS the APPEND reports no UID, and a draft without an id is unreachable.
        requireCapability(client, 'UIDPLUS', 'create_draft');
        return { ...(await this.#storeDraft(client, path, uidValidity, raw)), warnings: [] };
      });
    });
  }

  async updateDraft(ref: MessageRef, patch: DraftPatch): Promise<DraftOutcome> {
    assertOwnAccount(this.account, ref.account);
    return this.pool.use(this.account, async (client) => {
      await this.#assertDraft(client, ref);
      return withMailbox(
        client,
        ref.mailbox,
        { access: 'write', from: 'id' },
        async (uidValidity) => {
          assertCurrent(ref, uidValidity);
          // Removing the old version needs UID EXPUNGE; a plain EXPUNGE would hit other clients' mail (D17).
          requireCapability(client, 'UIDPLUS', 'update_draft');
          const stored = await readStored(client, ref);
          // A new body replaces the old one in both forms: body without htmlBody drops the HTML.
          const bodyGiven = patch.body !== undefined || patch.htmlBody !== undefined;
          const raw = await buildMime(
            accountSpec(this.account, {
              to: patch.to === undefined ? stored.to : plainAddresses(patch.to),
              cc: patch.cc === undefined ? stored.cc : plainAddresses(patch.cc),
              bcc: patch.bcc === undefined ? stored.bcc : plainAddresses(patch.bcc),
              subject: patch.subject ?? stored.subject,
              text: bodyGiven ? patch.body : stored.text,
              html: bodyGiven ? patch.htmlBody : stored.html,
              // Replaced, never carried over (D16).
              attachments: decodeAttachments(patch.attachments),
              inReplyTo: stored.inReplyTo,
              references: stored.references,
            }),
            { keepBcc: true },
          );
          const created = await this.#storeDraft(client, ref.mailbox, uidValidity, raw);
          const removed = await client
            .messageDelete(String(ref.uid), { uid: true })
            .catch(() => false);
          return { ...created, warnings: removed ? [] : [OLD_DRAFT_KEPT_WARNING] };
        },
      );
    });
  }

  async deleteDraft(ref: MessageRef): Promise<MoveOutcome> {
    assertOwnAccount(this.account, ref.account);
    return this.pool.use(this.account, async (client) => {
      await this.#assertDraft(client, ref);
      const trash = await this.#special(client, '\\Trash');
      return withMailbox(
        client,
        ref.mailbox,
        { access: 'write', from: 'id' },
        async (uidValidity) => {
          assertCurrent(ref, uidValidity);
          // Without MOVE imapflow emulates it with COPY and EXPUNGE (D17).
          requireCapability(client, 'MOVE', 'delete_draft');
          return this.#move(client, ref.mailbox, [ref.uid], trash);
        },
      );
    });
  }

  send(c: Composition): Promise<SendOutcome> {
    return this.#deliver(sendSpec(this.account, c));
  }

  async sendDraft(ref: MessageRef): Promise<SendOutcome> {
    assertOwnAccount(this.account, ref.account);
    const spec = await this.pool.use(this.account, async (client) => {
      // Before the send: removing the sent draft needs UID EXPUNGE (D17).
      requireCapability(client, 'UIDPLUS', 'send with draftId');
      // The draft is expunged after the send, so an id outside the drafts mailbox must never get there.
      await this.#assertDraft(client, ref);
      return withMailbox(
        client,
        ref.mailbox,
        { access: 'read', from: 'id' },
        async (uidValidity) => {
          assertCurrent(ref, uidValidity);
          // Rebuilt from its fields: the draft's Bcc goes to the envelope and the Sent copy, never to recipients.
          const stored = await readStored(client, ref);
          return accountSpec(this.account, {
            to: stored.to,
            cc: stored.cc,
            bcc: stored.bcc,
            subject: stored.subject,
            text: stored.text,
            html: stored.html,
            attachments: stored.attachments,
            inReplyTo: stored.inReplyTo,
            references: stored.references,
          });
        },
      );
    });
    return this.#deliver(spec, ref);
  }

  async reply(ref: MessageRef, input: ReplyInput): Promise<SendOutcome> {
    const context = await this.#replyContext(ref, input.htmlBody !== undefined, input.replyAll);
    return this.#deliver(replySpec(this.account, context, input));
  }

  async forward(ref: MessageRef, input: ForwardInput): Promise<SendOutcome> {
    assertOwnAccount(this.account, ref.account);
    // The whole original, within the size limit: its full text and every attachment go along.
    const stored = await this.pool.use(this.account, (client) =>
      withMailbox(client, ref.mailbox, { access: 'read', from: 'id' }, async (uidValidity) => {
        assertCurrent(ref, uidValidity);
        return readStored(client, ref);
      }),
    );
    const original = await this.reader.getMessage(ref, 'metadata');
    const quoted = quotedOriginal(original, stored.text, stored.html);
    return this.#deliver(forwardSpec(this.account, quoted, stored.attachments, input));
  }

  updateLabels(target: WriteTarget, change: LabelChange): Promise<MoveOutcome> {
    return this.pool.use(this.account, (client) =>
      this.account.provider === 'gmail'
        ? this.#updateGmailLabels(client, target, change)
        : this.#updateFolders(client, target, change),
    );
  }

  async manageLabel(action: LabelAction): Promise<void> {
    await this.pool.use(this.account, async (client) => {
      const box = (await client.list()).find((b) => b.path === action.name);
      if (action.action === 'create') {
        // GreenMail answers a CREATE of an existing name with a plain NO, not ALREADYEXISTS.
        if (box === undefined) await client.mailboxCreate(action.name);
        return;
      }
      if (box === undefined) throw unknownMailbox(action.name);
      if (this.#isSystemMailbox(box.path, box.specialUse)) {
        throw new MailError('not_permitted', 'System mailboxes cannot be renamed or deleted.');
      }
      if (action.action === 'rename') {
        await client.mailboxRename(box.path, action.newName);
        return;
      }
      // Deleting an IMAP folder deletes its messages; deleting a Gmail label keeps them (D23).
      if (this.account.provider !== 'gmail') {
        const status = await client.status(box.path, { messages: true });
        if (status === false || status.messages === undefined) {
          throw new Error(`The server did not report how many messages "${box.path}" holds.`);
        }
        if (status.messages > 0) {
          throw new MailError(
            'not_permitted',
            `The folder still holds ${String(status.messages)} messages; move them out first.`,
          );
        }
      }
      await client.mailboxDelete(box.path);
    });
  }

  trash(target: WriteTarget): Promise<MoveOutcome> {
    return this.#relocate(target, 'trash', undefined, '\\Trash');
  }

  untrash(target: WriteTarget): Promise<MoveOutcome> {
    return this.#relocate(target, 'untrash', '\\Trash', RESTORE);
  }

  markSpam(target: WriteTarget): Promise<MoveOutcome> {
    return this.#relocate(target, 'mark_spam', undefined, '\\Junk');
  }

  unmarkSpam(target: WriteTarget): Promise<MoveOutcome> {
    return this.#relocate(target, 'unmark_spam', '\\Junk', RESTORE);
  }

  /** Gmail (D22): names go to X-GM-LABELS, UNREAD and STARRED to flags; the ids do not change. */
  #updateGmailLabels(
    client: ImapClient,
    target: WriteTarget,
    change: LabelChange,
  ): Promise<MoveOutcome> {
    const labelChange = gmailLabelChange(change);
    // Without X-GM-EXT-1 imapflow skips a label STORE and reports false.
    requireCapability(client, 'X-GM-EXT-1', 'update_labels');
    return this.#onTarget(client, target, undefined, async (path, uidValidity, uids) => {
      await this.#store(client, uids, labelChange, true);
      await this.#store(client, uids, flagChange(change), false);
      return { messageIds: this.#ids(path, uidValidity, uids), warnings: [] };
    });
  }

  /** Other accounts (D22): flags first, then at most one move; the answer carries the new ids. */
  #updateFolders(
    client: ImapClient,
    target: WriteTarget,
    change: LabelChange,
  ): Promise<MoveOutcome> {
    return this.#onTarget(client, target, undefined, async (path, uidValidity, uids) => {
      const planned = folderDestination(change, path);
      const destination = planned === ARCHIVE ? await this.#special(client, '\\Archive') : planned;
      // A move into the folder the messages are already in would only renumber them (measured).
      const moves = destination !== undefined && destination !== path;
      if (moves) {
        // Both before the first flag, so a move that cannot happen changes nothing.
        requireCapability(client, 'MOVE', 'update_labels');
        if (!(await client.list()).some((box) => box.path === destination)) {
          throw unknownMailbox(destination);
        }
      }
      await this.#store(client, uids, flagChange(change), false);
      return moves
        ? this.#move(client, path, uids, destination)
        : { messageIds: this.#ids(path, uidValidity, uids), warnings: [] };
    });
  }

  /**
   * Moves the target to `to` (D24). `from` is the mailbox a thread is looked for in (a message id
   * names its own); RESTORE is All Mail on Gmail and INBOX elsewhere.
   */
  #relocate(
    target: WriteTarget,
    tool: string,
    from: keyof typeof RESTORE_SOURCES | undefined,
    to: SpecialUse | typeof RESTORE,
  ): Promise<MoveOutcome> {
    return this.pool.use(this.account, async (client) => {
      // Without MOVE imapflow emulates it with COPY and EXPUNGE (D17).
      requireCapability(client, 'MOVE', tool);
      assertOwnAccount(this.account, target.ref.account);
      const source = from === undefined ? undefined : await this.#special(client, from);
      // A restore moves out of the trash or spam only: any other id would be moved by mistake.
      if (from !== undefined && target.kind === 'message' && target.ref.mailbox !== source) {
        throw new MailError('not_found', RESTORE_SOURCES[from]);
      }
      const destination =
        to === RESTORE ? await this.#restorePath(client) : await this.#special(client, to);
      return this.#onTarget(client, target, source, (path, _uidValidity, uids) =>
        this.#move(client, path, uids, destination),
      );
    });
  }

  #restorePath(client: ImapClient): Promise<string> {
    return this.account.provider === 'gmail'
      ? this.#special(client, '\\All')
      : Promise.resolve('INBOX');
  }

  /**
   * Runs `fn` under a write lock on the target's mailbox with the target's UIDs there: a message
   * id's own UID, or every message of a thread (looked for in `mailbox` when given). No match is
   * `not_found`.
   */
  async #onTarget<T>(
    client: ImapClient,
    target: WriteTarget,
    mailbox: string | undefined,
    fn: (path: string, uidValidity: string, uids: number[]) => Promise<T>,
  ): Promise<T> {
    assertOwnAccount(this.account, target.ref.account);
    if (target.kind === 'message') {
      const { ref } = target;
      return withMailbox(
        client,
        ref.mailbox,
        { access: 'write', from: 'id' },
        async (uidValidity) => {
          assertCurrent(ref, uidValidity);
          const found = await client.search({ uid: String(ref.uid) }, { uid: true });
          const uids = sortedUids(found, 'asc');
          if (uids.length === 0) throw messageGone();
          return fn(ref.mailbox, uidValidity, uids);
        },
      );
    }
    const { path, criteria } = await threadLocation(client, this.account, target.ref, mailbox);
    return withMailbox(client, path, { access: 'write', from: 'id' }, async (uidValidity) => {
      const uids = sortedUids(await client.search(criteria, { uid: true }), 'asc');
      if (uids.length === 0) {
        throw new MailError(
          'not_found',
          `No messages of this thread were found in "${path}"; search again.`,
        );
      }
      return fn(path, uidValidity, uids);
    });
  }

  /** Adds, then removes, flags (or Gmail labels with `useLabels`) on `uids` of the locked mailbox. */
  async #store(
    client: ImapClient,
    uids: number[],
    change: FlagChange,
    useLabels: boolean,
  ): Promise<void> {
    const range = uids.join(',');
    const options = useLabels ? { uid: true, useLabels: true } : { uid: true };
    const what = useLabels ? 'labels' : 'flags';
    // imapflow answers false, without throwing, to a NO or BAD and to flags the mailbox refuses.
    const refused = (op: string): MailError =>
      new MailError('update_failed', `The mail server refused to ${op} the ${what}.`);
    if (change.add.length > 0 && !(await client.messageFlagsAdd(range, change.add, options))) {
      throw refused('add');
    }
    if (
      change.remove.length > 0 &&
      !(await client.messageFlagsRemove(range, change.remove, options))
    ) {
      throw refused('remove');
    }
  }

  #ids(path: string, uidValidity: string, uids: number[]): string[] {
    return uids.map((uid) =>
      encodeMessageId({ account: this.account.id, mailbox: path, uidValidity, uid }),
    );
  }

  #special(client: ImapClient, use: SpecialUse): Promise<string> {
    return resolveMailbox(client, { kind: 'special', use }, this.account.mailboxes);
  }

  /** D23: INBOX, every special-use mailbox and every mailbox the account config names. */
  #isSystemMailbox(path: string, specialUse: string | undefined): boolean {
    return (
      path.toUpperCase() === 'INBOX' ||
      specialUse !== undefined ||
      Object.values(this.account.mailboxes).includes(path)
    );
  }

  #draftsPath(client: ImapClient): Promise<string> {
    return this.#special(client, '\\Drafts');
  }

  /** update_draft expunges the old version, so an id outside the drafts mailbox must never get there (D17). */
  async #assertDraft(client: ImapClient, ref: MessageRef): Promise<void> {
    if (ref.mailbox !== (await this.#draftsPath(client))) {
      throw new MailError(
        'not_found',
        'This id is not a draft (it is not in the drafts mailbox); use list_drafts to find draft ids.',
      );
    }
  }

  /** APPENDs a draft to the locked mailbox `path` and returns its ids. */
  async #storeDraft(
    client: ImapClient,
    path: string,
    uidValidity: string,
    raw: Buffer,
  ): Promise<Omit<DraftOutcome, 'warnings'>> {
    const appended = await client.append(path, raw, DRAFT_FLAGS);
    if (appended === false || appended.uid === undefined) {
      throw new Error('The server did not report the UID of the stored draft.');
    }
    const uid = appended.uid;
    // The append went to the locked mailbox, so its UIDVALIDITY applies when APPENDUID had none.
    const draftId = encodeMessageId({
      account: this.account.id,
      mailbox: path,
      uidValidity: appended.uidValidity?.toString() ?? uidValidity,
      uid,
    });
    const stored = await client.fetchOne(
      String(uid),
      { uid: true, ...threadIdFields(this.account) },
      { uid: true },
    );
    if (stored === false) throw messageGone();
    return { draftId, threadId: messageThreadId(this.account, path, stored) };
  }

  /**
   * Moves `uids` of the locked mailbox `path` to `destination` and returns their new ids. A UID
   * the server's COPYUID map does not list is left out and reported in one warning.
   */
  async #move(
    client: ImapClient,
    path: string,
    uids: number[],
    destination: string,
  ): Promise<MoveOutcome> {
    const result = await client.messageMove(uids.join(','), destination, { uid: true });
    if (result === false) {
      throw new Error(`The server refused to move messages from "${path}" to "${destination}".`);
    }
    // COPYUID carries both; without it no new id can be formed.
    const uidValidity = result.uidValidity?.toString();
    const uidMap = uidValidity === undefined ? undefined : result.uidMap;
    const messageIds: string[] = [];
    for (const uid of uids) {
      const moved = uidMap?.get(uid);
      if (moved === undefined || uidValidity === undefined) continue;
      messageIds.push(
        encodeMessageId({
          account: this.account.id,
          mailbox: destination,
          uidValidity,
          uid: moved,
        }),
      );
    }
    const missing = uids.length - messageIds.length;
    const warnings =
      missing === 0
        ? []
        : [
            `${String(missing)} moved message(s) got no new id from the server; search "${destination}" to find them.`,
          ];
    return { messageIds, warnings };
  }

  /** The original's quote, threading headers and recipients; shared by reply drafts and reply(). */
  async #replyContext(
    ref: MessageRef,
    withHtml: boolean,
    replyAll: boolean,
  ): Promise<ReplyContext> {
    assertOwnAccount(this.account, ref.account);
    // MessageDetail has no References, so the writer fetches them itself.
    const headers = await this.pool.use(this.account, (client) =>
      withMailbox(client, ref.mailbox, { access: 'read', from: 'id' }, async (uidValidity) => {
        assertCurrent(ref, uidValidity);
        const msg = await client.fetchOne(
          String(ref.uid),
          { uid: true, envelope: true, headers: ['references'] },
          { uid: true },
        );
        if (msg === false) throw messageGone();
        return {
          messageId: msg.envelope?.messageId,
          references: referenceIds(msg.headers),
        };
      }),
    );
    const original = await this.reader.getMessage(ref, 'plain');
    const html = withHtml
      ? ((await this.reader.getMessage(ref, 'html')).body ?? undefined)
      : undefined;
    return replyContext(this.account, original, html, headers, replyAll);
  }

  /**
   * Sends `spec` (D18): SMTP gets it without the Bcc header, the envelope names every recipient.
   * Only a successful send writes to IMAP: the Sent copy (not on Gmail, whose SMTP stores it) and
   * the removal of `removeDraft`. Either failing is a warning, never an error: the mail is sent.
   */
  async #deliver(spec: MimeSpec, removeDraft?: MessageRef): Promise<SendOutcome> {
    const envelope = envelopeFor(spec);
    const { rejected } = await this.smtp(
      this.account,
      await buildMime(spec, { keepBcc: false }),
      envelope,
    );
    // The addresses go into the tool result only: runTool never logs a result.
    const warnings = rejected.length > 0 ? [rejectedRecipientsWarning(rejected)] : [];
    let sentCopyId: string | null = null;
    if (this.account.provider !== 'gmail') {
      try {
        sentCopyId = await this.#storeSentCopy(spec);
        if (sentCopyId === null) warnings.push(SENT_COPY_WITHOUT_ID_WARNING);
      } catch {
        warnings.push(SENT_COPY_FAILED_WARNING);
      }
    }
    if (removeDraft !== undefined && !(await this.#removeDraft(removeDraft).catch(() => false))) {
      warnings.push(SENT_DRAFT_KEPT_WARNING);
    }
    const addresses = (list: Address[]): string[] => list.map((a) => a.address);
    return {
      messageIdHeader: spec.messageId,
      // In the tool result only: runTool never logs a result.
      to: addresses(spec.to),
      cc: addresses(spec.cc),
      bcc: addresses(spec.bcc),
      sentCopyId,
      warnings,
    };
  }

  /** APPENDs the sent message, Bcc included, to the Sent mailbox; null when it got no id. */
  #storeSentCopy(spec: MimeSpec): Promise<string | null> {
    return this.pool.use(this.account, async (client) => {
      const path = await this.#special(client, '\\Sent');
      const raw = await buildMime(spec, { keepBcc: true });
      const appended = await client.append(path, raw, ['\\Seen']);
      // A NO throws; imapflow answers false when it could not issue the APPEND at all.
      if (appended === false) throw new Error(`The server refused the APPEND to "${path}".`);
      // APPENDUID carries both; without it the copy is stored but has no id.
      if (appended.uid === undefined || appended.uidValidity === undefined) return null;
      return encodeMessageId({
        account: this.account.id,
        mailbox: path,
        uidValidity: appended.uidValidity.toString(),
        uid: appended.uid,
      });
    });
  }

  /** Removes a sent draft with UID EXPUNGE (D17); false when the server did not. */
  #removeDraft(ref: MessageRef): Promise<boolean> {
    return this.pool.use(this.account, (client) =>
      withMailbox(client, ref.mailbox, { access: 'write', from: 'id' }, async (uidValidity) => {
        assertCurrent(ref, uidValidity);
        // Checked before the send too; again here, since a plain EXPUNGE would hit other mail.
        requireCapability(client, 'UIDPLUS', 'send with draftId');
        return client.messageDelete(String(ref.uid), { uid: true });
      }),
    );
  }
}
