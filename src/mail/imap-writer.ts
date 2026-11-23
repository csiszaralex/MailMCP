import type { Account } from '../config/types.js';
import { MailError } from '../errors.js';
import { encodeMessageId, type MessageRef } from '../ids.js';
import type { ImapClient } from '../imap/client.js';
import { resolveMailbox } from '../imap/mailboxes.js';
import { requireCapability, withMailbox } from '../imap/mailbox-lock.js';
import type { ImapPool } from '../imap/pool.js';
import type { SmtpSend } from '../smtp/sender.js';
import { replyRecipients } from './addresses.js';
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
import type { Address, MailProvider } from './types.js';
import type {
  Composition,
  DraftOutcome,
  DraftPatch,
  MailWriter,
  MoveOutcome,
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

/** Tool input addresses are bare e-mail addresses (the tool schema validates them). */
function plainAddresses(list: string[]): Address[] {
  return list.map((address) => ({ name: '', address }));
}

export class ImapMailWriter implements Pick<
  MailWriter,
  'account' | 'createDraft' | 'updateDraft' | 'deleteDraft'
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
      const trash = await resolveMailbox(
        client,
        { kind: 'special', use: '\\Trash' },
        this.account.mailboxes,
      );
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
    return resolveMailbox(client, { kind: 'special', use: '\\Drafts' }, this.account.mailboxes);
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
