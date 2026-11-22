import { buffer } from 'node:stream/consumers';
import type { FetchMessageObject, FetchQueryObject, SearchObject } from 'imapflow';
import type { Account } from '../config/types.js';
import { MailError } from '../errors.js';
import { encodeMessageId, encodeThreadId, type MessageRef, type ThreadRef } from '../ids.js';
import type { ImapClient } from '../imap/client.js';
import { resolveMailbox } from '../imap/mailboxes.js';
import type { ImapPool } from '../imap/pool.js';
import { translateQuery } from '../search/query.js';
import {
  assertRawSize,
  rawBody,
  RAW_LIMIT_BYTES,
  renderText,
  TEXT_PART_LIMIT_BYTES,
  type RenderedBody,
  type TextPart,
} from './body.js';
import {
  collectAttachments,
  messageDate,
  receivedDate,
  textParts,
  threadRootId,
  toAddresses,
} from './message-parts.js';
import type {
  AttachmentContent,
  BodyFormat,
  LabelInfo,
  MailProvider,
  MessageDetail,
  MessageSummary,
  SearchPage,
  ThreadPage,
} from './types.js';

export const ATTACHMENT_LIMIT_BYTES = 12 * 1024 * 1024;
export const THREAD_MESSAGE_LIMIT = 50;

export class ImapMailProvider implements MailProvider {
  constructor(
    readonly account: Account,
    private readonly pool: ImapPool,
  ) {}

  get #gmail(): boolean {
    return this.account.provider === 'gmail';
  }

  search(query: string, offset: number, limit: number): Promise<SearchPage> {
    return this.pool.use(this.account, async (client) => {
      const { path, criteria } = await this.#searchTarget(client, query);
      return this.#page(client, path, criteria, offset, limit);
    });
  }

  listDrafts(offset: number, limit: number): Promise<SearchPage> {
    return this.pool.use(this.account, async (client) => {
      const path = await resolveMailbox(
        client,
        { kind: 'special', use: '\\Drafts' },
        this.account.mailboxes,
      );
      return this.#page(client, path, { all: true }, offset, limit);
    });
  }

  // async: a foreign id must reject the returned promise, not throw before one exists.
  async getMessage(ref: MessageRef, format: BodyFormat): Promise<MessageDetail> {
    this.#assertOwn(ref.account);
    return this.pool.use(this.account, (client) =>
      this.#withMailbox(client, ref.mailbox, 'id', async (uidValidity) => {
        assertCurrent(ref, uidValidity);
        const [detail] = await this.#details(client, ref.mailbox, uidValidity, [ref.uid], format);
        if (detail === undefined) throw messageGone();
        return detail;
      }),
    );
  }

  async getThread(ref: ThreadRef, format: BodyFormat): Promise<ThreadPage> {
    this.#assertOwn(ref.account);
    if (format === 'raw') {
      // Up to THREAD_MESSAGE_LIMIT raw sources of RAW_LIMIT_BYTES each would not fit in memory.
      throw new MailError(
        'unsupported_format',
        'The raw format is not available for a whole thread; use get_message for one message.',
      );
    }
    return this.pool.use(this.account, async (client) => {
      let path: string;
      let criteria: SearchObject;
      if (ref.kind === 'gmail') {
        path = await resolveMailbox(
          client,
          { kind: 'special', use: '\\All' },
          this.account.mailboxes,
        );
        criteria = { threadId: ref.gmailThreadId };
      } else {
        if (ref.rootMessageId === '') {
          throw new MailError(
            'not_found',
            'This message has no Message-ID header, so it has no thread; use get_message.',
          );
        }
        path = ref.mailbox;
        criteria = {
          or: [
            { header: { 'message-id': ref.rootMessageId } },
            { header: { references: ref.rootMessageId } },
          ],
        };
      }
      return this.#withMailbox(client, path, 'id', async (uidValidity) => {
        const all = sortedUids(await client.search(criteria, { uid: true }), 'asc');
        if (all.length === 0) {
          throw new MailError('not_found', 'No messages of this thread were found; search again.');
        }
        const newest = all.slice(-THREAD_MESSAGE_LIMIT);
        return {
          messages: await this.#details(client, path, uidValidity, newest, format),
          olderOmitted: all.length - newest.length,
        };
      });
    });
  }

  async downloadAttachment(ref: MessageRef, attachmentId: string): Promise<AttachmentContent> {
    this.#assertOwn(ref.account);
    return this.pool.use(this.account, (client) =>
      this.#withMailbox(client, ref.mailbox, 'id', async (uidValidity) => {
        assertCurrent(ref, uidValidity);
        const msg = await client.fetchOne(
          String(ref.uid),
          { uid: true, bodyStructure: true },
          { uid: true },
        );
        if (msg === false) throw new MailError('not_found', 'Message not found.');
        const info = collectAttachments(msg.bodyStructure).find(
          (a) => a.attachmentId === attachmentId,
        );
        if (info === undefined) {
          throw new MailError(
            'not_found',
            `Attachment ${attachmentId} not found; use get_message to list attachments.`,
          );
        }
        const download = await client.download(String(ref.uid), attachmentId, {
          uid: true,
          maxBytes: ATTACHMENT_LIMIT_BYTES + 1,
        });
        if (download.content === undefined)
          throw new MailError('not_found', 'Attachment content not found.');
        const data = await buffer(download.content);
        if (data.length > ATTACHMENT_LIMIT_BYTES) {
          throw new MailError(
            'too_large',
            `The attachment is larger than ${String(ATTACHMENT_LIMIT_BYTES)} bytes.`,
          );
        }
        return { filename: info.filename, mimeType: info.mimeType, data };
      }),
    );
  }

  listLabels(): Promise<LabelInfo[]> {
    return this.pool.use(this.account, async (client) =>
      (await client.list())
        .filter((box) => !box.flags.has('\\Noselect'))
        .map((box) => ({ name: box.path, specialUse: box.specialUse ?? null })),
    );
  }

  /** Second line of defense: the tool layer's inScope (read-tools.ts) checks the same with the same code. */
  #assertOwn(accountId: string): void {
    if (accountId !== this.account.id) {
      throw new MailError(
        'unknown_account',
        `This id belongs to account "${accountId}", not "${this.account.id}".`,
      );
    }
  }

  async #searchTarget(
    client: ImapClient,
    query: string,
  ): Promise<{ path: string; criteria: SearchObject }> {
    if (this.#gmail) {
      const path = await resolveMailbox(
        client,
        { kind: 'special', use: '\\All' },
        this.account.mailboxes,
      );
      return { path, criteria: query.trim() === '' ? { all: true } : { gmraw: query } };
    }
    const translated = translateQuery(query);
    const path = await resolveMailbox(client, translated.mailbox, this.account.mailboxes);
    return { path, criteria: translated.criteria };
  }

  /** `from` says where the path came from, so a missing mailbox gets the right hint. */
  async #withMailbox<T>(
    client: ImapClient,
    path: string,
    from: 'query' | 'id',
    fn: (uidValidity: string) => Promise<T>,
  ): Promise<T> {
    let lock;
    try {
      lock = await client.getMailboxLock(path, { readOnly: true });
    } catch (err) {
      // imapflow sets mailboxMissing when SELECT/EXAMINE failed and LIST does not show the path.
      if (err instanceof Error && 'mailboxMissing' in err && err.mailboxMissing === true) {
        throw new MailError(
          'mailbox_not_found',
          from === 'id'
            ? `The mailbox "${path}" of this id no longer exists, so the id is outdated; search again.`
            : `Mailbox "${path}" does not exist on this account; use list_labels to see the mailboxes.`,
          { cause: err },
        );
      }
      throw err;
    }
    try {
      const mailbox = client.mailbox;
      // Only after the connection dropped right after the lock: not a missing mailbox.
      if (mailbox === false) throw new Error('No mailbox is selected after the lock.');
      return await fn(mailbox.uidValidity.toString());
    } finally {
      lock.release();
    }
  }

  #page(
    client: ImapClient,
    path: string,
    criteria: SearchObject,
    offset: number,
    limit: number,
  ): Promise<SearchPage> {
    return this.#withMailbox(client, path, 'query', async (uidValidity) => {
      const uids = sortedUids(await client.search(criteria, { uid: true }), 'desc');
      const slice = uids.slice(offset, offset + limit);
      const messages =
        slice.length === 0 ? [] : await this.#summaries(client, path, uidValidity, slice);
      return { total: uids.length, messages };
    });
  }

  #summaryQuery(): FetchQueryObject {
    return {
      uid: true,
      envelope: true,
      flags: true,
      internalDate: true,
      ...(this.#gmail ? { labels: true, threadId: true } : { headers: ['references'] }),
    };
  }

  async #summaries(
    client: ImapClient,
    path: string,
    uidValidity: string,
    uids: number[],
  ): Promise<MessageSummary[]> {
    const fetched = await client.fetchAll(uids.join(','), this.#summaryQuery(), { uid: true });
    const byUid = new Map(fetched.map((msg) => [msg.uid, msg]));
    return uids.flatMap((uid) => {
      const msg = byUid.get(uid);
      return msg === undefined ? [] : [this.#summary(path, uidValidity, msg)];
    });
  }

  async #details(
    client: ImapClient,
    path: string,
    uidValidity: string,
    uids: number[],
    format: BodyFormat,
  ): Promise<MessageDetail[]> {
    if (uids.length === 0) return [];
    // Metadata only: bodies are fetched below one message at a time, never as full sources.
    const query: FetchQueryObject = { ...this.#summaryQuery(), bodyStructure: true, size: true };
    const fetched = await client.fetchAll(uids.join(','), query, { uid: true });
    const byUid = new Map(fetched.map((msg) => [msg.uid, msg]));
    const details: MessageDetail[] = [];
    for (const uid of uids) {
      const msg = byUid.get(uid);
      if (msg === undefined) continue;
      details.push({
        ...this.#summary(path, uidValidity, msg),
        messageIdHeader: msg.envelope?.messageId ?? null,
        inReplyTo: msg.envelope?.inReplyTo ?? null,
        attachments: collectAttachments(msg.bodyStructure),
        format,
        ...(format === 'metadata'
          ? { body: null, truncated: false }
          : await this.#body(client, msg, format)),
      });
    }
    return details;
  }

  async #body(
    client: ImapClient,
    msg: FetchMessageObject,
    format: 'plain' | 'html' | 'raw',
  ): Promise<RenderedBody> {
    if (format === 'raw') {
      assertRawSize(msg.size ?? 0);
      const full = await client.fetchOne(
        String(msg.uid),
        { uid: true, source: { maxLength: RAW_LIMIT_BYTES + 1 } },
        { uid: true },
      );
      if (full === false || full.source === undefined) throw messageGone();
      return { body: rawBody(full.source), truncated: false };
    }
    const parts: TextPart[] = [];
    for (const ref of textParts(msg.bodyStructure, format)) {
      const download = await client.download(String(msg.uid), ref.part, {
        uid: true,
        maxBytes: TEXT_PART_LIMIT_BYTES + 1,
      });
      if (download.content === undefined) continue;
      const data = await buffer(download.content);
      const cut = data.length > TEXT_PART_LIMIT_BYTES;
      parts.push({
        type: ref.type,
        charset: download.meta.charset,
        content: cut ? data.subarray(0, TEXT_PART_LIMIT_BYTES) : data,
        cut,
      });
    }
    return renderText(parts, format);
  }

  #summary(path: string, uidValidity: string, msg: FetchMessageObject): MessageSummary {
    return {
      id: encodeMessageId({ account: this.account.id, mailbox: path, uidValidity, uid: msg.uid }),
      threadId: this.#threadId(path, msg),
      account: this.account.id,
      mailbox: path,
      date: messageDate(msg),
      receivedAt: receivedDate(msg),
      from: toAddresses(msg.envelope?.from),
      to: toAddresses(msg.envelope?.to),
      cc: toAddresses(msg.envelope?.cc),
      subject: msg.envelope?.subject ?? '',
      flags: [...(msg.flags ?? [])],
      labels: [...(msg.labels ?? [])],
    };
  }

  #threadId(path: string, msg: FetchMessageObject): string {
    if (this.#gmail && msg.threadId !== undefined) {
      return encodeThreadId({
        kind: 'gmail',
        account: this.account.id,
        gmailThreadId: msg.threadId,
      });
    }
    const root = threadRootId(msg.headers, msg.envelope?.messageId) ?? '';
    return encodeThreadId({
      kind: 'references',
      account: this.account.id,
      mailbox: path,
      rootMessageId: root,
    });
  }
}

/** A message id names a UID under one UIDVALIDITY; after the server rebuilt the mailbox it is void. */
function assertCurrent(ref: MessageRef, uidValidity: string): void {
  if (uidValidity !== ref.uidValidity) {
    throw new MailError(
      'stale_id',
      'This message id is outdated (the mailbox was rebuilt); search again.',
    );
  }
}

function messageGone(): MailError {
  return new MailError('not_found', 'Message not found; it may have been moved or deleted.');
}

/** imapflow resolves false when the server answers NO or BAD, and undefined without a mailbox. */
function sortedUids(found: number[] | false | undefined, order: 'asc' | 'desc'): number[] {
  if (found === false || found === undefined) {
    throw new MailError(
      'search_failed',
      'The mail server rejected this search; try simpler terms.',
    );
  }
  return [...found].sort((a, b) => (order === 'asc' ? a - b : b - a));
}
