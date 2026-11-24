import type { Account } from '../config/types.js';
import { MailError } from '../errors.js';
import { encodeMessageId, type MessageRef } from '../ids.js';
import type { ImapClient } from '../imap/client.js';
import { resolveMailbox } from '../imap/mailboxes.js';
import { requireCapability, unknownMailbox, withMailbox } from '../imap/mailbox-lock.js';
import type { ImapPool } from '../imap/pool.js';
import type { SpecialUse } from '../search/query.js';
import type { SmtpSend } from '../smtp/sender.js';
import { replyRecipients } from './addresses.js';
import { sortedUids } from './imap-provider.js';
import {
  ARCHIVE,
  flagChange,
  folderDestination,
  gmailLabelChange,
  type FlagChange,
} from './label-plan.js';
import {
  buildMime,
  decodeAttachments,
  newMessageId,
  prefixSubject,
  quoteReply,
  withSignature,
  type MimeSpec,
  type QuotedOriginal,
} from './compose.js';
import { messageThreadId, referenceIds, threadIdFields, toAddresses } from './message-parts.js';
import { assertCurrent, assertOwnAccount, messageGone } from './ref-checks.js';
import { readStored } from './stored.js';
import { threadLocation } from './thread-locate.js';
import type { Address, MailProvider } from './types.js';
import type {
  Composition,
  DraftOutcome,
  DraftPatch,
  LabelAction,
  LabelChange,
  MailWriter,
  MoveOutcome,
  WriteTarget,
} from './write-types.js';

export const OLD_DRAFT_KEPT_WARNING =
  'The previous version of the draft could not be removed; delete it with delete_draft.';

const DRAFT_FLAGS = ['\\Draft', '\\Seen'];

/** What a reply (a reply draft, or reply()) takes from the original message (D19). */
interface ReplyContext {
  quoted: QuotedOriginal;
  /** `Re:` plus the original subject. */
  subject: string;
  inReplyTo: string | undefined;
  references: string[];
  /** Never empty: without other recipients the reply goes to the account itself (R3). */
  to: Address[];
  cc: Address[];
}

/** Where untrash and unmark_spam move to: All Mail on Gmail, INBOX elsewhere (D24). */
const RESTORE = Symbol('restore');

/** The message an untrash or unmark_spam id must be in, and the hint when it is not. */
const RESTORE_SOURCES = {
  '\\Trash': 'This message is not in the trash; search in:trash for its current id.',
  '\\Junk': 'This message is not in spam; search in:spam for its current id.',
} as const;

/** Tool input addresses are bare e-mail addresses (the tool schema validates them). */
function plainAddresses(list: string[]): Address[] {
  return list.map((address) => ({ name: '', address }));
}

export class ImapMailWriter implements Pick<
  MailWriter,
  | 'account'
  | 'createDraft'
  | 'updateDraft'
  | 'deleteDraft'
  | 'updateLabels'
  | 'manageLabel'
  | 'trash'
  | 'untrash'
  | 'markSpam'
  | 'unmarkSpam'
> {
  constructor(
    readonly account: Account,
    private readonly pool: ImapPool,
    private readonly reader: MailProvider,
    // protected, not private: nothing reads it until sending exists, and noUnusedLocals
    // rejects an unread private property.
    protected readonly smtp: SmtpSend,
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
    // A draft without any body still gets its signature and quote.
    const text = c.body === undefined && c.htmlBody === undefined ? '' : c.body;
    const signed = withSignature(
      text,
      c.htmlBody,
      c.includeSignature ? this.account.signature : undefined,
    );
    const body = reply === undefined ? signed : quoteReply(reply.quoted, signed.text, signed.html);
    const raw = await buildMime(
      this.#spec({
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
            this.#spec({
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

  /** The MIME spec of a message from this account: From is always the account's own address (R5). */
  #spec(fields: Omit<MimeSpec, 'from' | 'messageId' | 'date'>): MimeSpec {
    return {
      ...fields,
      from: this.account.address,
      messageId: newMessageId(this.account),
      date: new Date(),
    };
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
    // MessageDetail has neither Reply-To nor References, so the writer fetches them itself.
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
          replyTo: toAddresses(msg.envelope?.replyTo),
          references: referenceIds(msg.headers),
        };
      }),
    );
    const original = await this.reader.getMessage(ref, 'plain');
    const html = withHtml
      ? ((await this.reader.getMessage(ref, 'html')).body ?? undefined)
      : undefined;
    const recipients = replyRecipients(
      { from: original.from, to: original.to, cc: original.cc, replyTo: headers.replyTo },
      this.account,
      replyAll,
    );
    const { messageId } = headers;
    return {
      quoted: {
        from: original.from,
        date: original.date,
        subject: original.subject,
        to: original.to,
        text: original.body ?? '',
        html,
      },
      subject: prefixSubject('Re:', original.subject),
      inReplyTo: messageId,
      references: messageId === undefined ? headers.references : [...headers.references, messageId],
      to: recipients.to.length > 0 ? recipients.to : [{ name: '', address: this.account.address }],
      cc: recipients.cc,
    };
  }
}
