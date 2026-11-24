import { buffer } from 'node:stream/consumers';
import type { FetchMessageObject, FetchQueryObject, SearchObject } from 'imapflow';
import type { Account } from '../config/types.js';
import { MailError } from '../errors.js';
import { encodeMessageId, type MessageRef, type ThreadRef } from '../ids.js';
import type { ImapClient } from '../imap/client.js';
import { resolveMailbox } from '../imap/mailboxes.js';
import { withMailbox } from '../imap/mailbox-lock.js';
import type { ImapPool } from '../imap/pool.js';
import { gmailSearch, translateQuery } from '../search/query.js';
import {
  assertRawSize,
  BODY_TEXT_LIMIT_BYTES,
  rawBody,
  RAW_LIMIT_BYTES,
  renderText,
  type RenderedBody,
  type TextPart,
} from './body.js';
import { assertCurrent, assertOwnAccount, messageGone } from './ref-checks.js';
import { threadLocation } from './thread-locate.js';
import {
  collectAttachments,
  messageDate,
  messageThreadId,
  receivedDate,
  textParts,
  threadIdFields,
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
    assertOwnAccount(this.account, ref.account);
    return this.pool.use(this.account, (client) =>
      withMailbox(client, ref.mailbox, { access: 'read', from: 'id' }, async (uidValidity) => {
        assertCurrent(ref, uidValidity);
        const [detail] = await this.#details(client, ref.mailbox, uidValidity, [ref.uid], format);
        if (detail === undefined) throw messageGone();
        return detail;
      }),
    );
  }

  async getThread(ref: ThreadRef, format: BodyFormat): Promise<ThreadPage> {
    assertOwnAccount(this.account, ref.account);
    if (format === 'raw') {
      // Up to THREAD_MESSAGE_LIMIT raw sources of RAW_LIMIT_BYTES each would not fit in memory.
      throw new MailError(
        'unsupported_format',
        'The raw format is not available for a whole thread; use get_message for one message.',
      );
    }
    return this.pool.use(this.account, async (client) => {
      const { path, criteria } = await threadLocation(client, this.account, ref);
      return withMailbox(client, path, { access: 'read', from: 'id' }, async (uidValidity) => {
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
    assertOwnAccount(this.account, ref.account);
    return this.pool.use(this.account, (client) =>
      withMailbox(client, ref.mailbox, { access: 'read', from: 'id' }, async (uidValidity) => {
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

  async #searchTarget(
    client: ImapClient,
    query: string,
  ): Promise<{ path: string; criteria: SearchObject }> {
    if (this.#gmail) {
      const { mailbox, gmraw } = gmailSearch(query);
      const path = await resolveMailbox(
        client,
        { kind: 'special', use: mailbox },
        this.account.mailboxes,
      );
      return { path, criteria: gmraw.trim() === '' ? { all: true } : { gmraw } };
    }
    const translated = translateQuery(query);
    const path = await resolveMailbox(client, translated.mailbox, this.account.mailboxes);
    return { path, criteria: translated.criteria };
  }

  #page(
    client: ImapClient,
    path: string,
    criteria: SearchObject,
    offset: number,
    limit: number,
  ): Promise<SearchPage> {
    return withMailbox(client, path, { access: 'read', from: 'query' }, async (uidValidity) => {
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
      ...threadIdFields(this.account),
      ...(this.#gmail ? { labels: true } : {}),
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
        replyTo: toAddresses(msg.envelope?.replyTo),
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
    let budget = BODY_TEXT_LIMIT_BYTES;
    for (const ref of textParts(msg.bodyStructure, format)) {
      if (budget <= 0) {
        // Budget spent: the remaining parts are not downloaded, the body is truncated.
        const last = parts.at(-1);
        if (last !== undefined) last.cut = true;
        break;
      }
      const download = await client.download(String(msg.uid), ref.part, {
        uid: true,
        maxBytes: budget + 1,
      });
      if (download.content === undefined) continue;
      const data = await buffer(download.content);
      const cut = data.length > budget;
      const content = cut ? data.subarray(0, budget) : data;
      budget -= content.length;
      parts.push({ type: ref.type, charset: download.meta.charset, content, cut });
    }
    return renderText(parts, format);
  }

  #summary(path: string, uidValidity: string, msg: FetchMessageObject): MessageSummary {
    return {
      id: encodeMessageId({ account: this.account.id, mailbox: path, uidValidity, uid: msg.uid }),
      threadId: messageThreadId(this.account, path, msg),
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
}

/** imapflow resolves false when the server answers NO or BAD, and undefined without a mailbox. */
export function sortedUids(found: number[] | false | undefined, order: 'asc' | 'desc'): number[] {
  if (found === undefined) {
    // We hold a mailbox lock, so no selected mailbox means the connection went away meanwhile.
    throw new MailError(
      'connection_failed',
      'The connection to the mail server was lost during the search; try again.',
    );
  }
  if (found === false) {
    throw new MailError(
      'search_failed',
      'The mail server rejected this search; try simpler terms.',
    );
  }
  return [...found].sort((a, b) => (order === 'asc' ? a - b : b - a));
}
