import { buffer } from 'node:stream/consumers';
import type { FetchMessageObject, FetchQueryObject, SearchObject } from 'imapflow';
import type { Account } from '../config/types.js';
import { MailError } from '../errors.js';
import { encodeMessageId, encodeThreadId, type MessageRef, type ThreadRef } from '../ids.js';
import type { ImapClient } from '../imap/client.js';
import { resolveMailbox } from '../imap/mailboxes.js';
import type { ImapPool } from '../imap/pool.js';
import { translateQuery } from '../search/query.js';
import { renderBody } from './body.js';
import { collectAttachments, messageDate, threadRootId, toAddresses } from './message-parts.js';
import type {
  AttachmentContent,
  BodyFormat,
  LabelInfo,
  MailProvider,
  MessageDetail,
  MessageSummary,
  SearchPage,
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
      this.#withMailbox(client, ref.mailbox, async (uidValidity) => {
        if (uidValidity !== ref.uidValidity) {
          throw new MailError(
            'stale_id',
            'This message id is outdated (the mailbox was rebuilt); search again.',
          );
        }
        const [detail] = await this.#details(client, ref.mailbox, uidValidity, [ref.uid], format);
        if (detail === undefined)
          throw new MailError('not_found', 'Message not found; it may have been moved or deleted.');
        return detail;
      }),
    );
  }

  async getThread(ref: ThreadRef, format: BodyFormat): Promise<MessageDetail[]> {
    this.#assertOwn(ref.account);
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
      return this.#withMailbox(client, path, async (uidValidity) => {
        const uids = sortedUids(await client.search(criteria, { uid: true }), 'asc').slice(
          0,
          THREAD_MESSAGE_LIMIT,
        );
        return this.#details(client, path, uidValidity, uids, format);
      });
    });
  }

  async downloadAttachment(ref: MessageRef, attachmentId: string): Promise<AttachmentContent> {
    this.#assertOwn(ref.account);
    return this.pool.use(this.account, (client) =>
      this.#withMailbox(client, ref.mailbox, async (uidValidity) => {
        if (uidValidity !== ref.uidValidity) {
          throw new MailError('stale_id', 'This message id is outdated; search again.');
        }
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

  #assertOwn(accountId: string): void {
    if (accountId !== this.account.id) {
      throw new MailError(
        'invalid_id',
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

  async #withMailbox<T>(
    client: ImapClient,
    path: string,
    fn: (uidValidity: string) => Promise<T>,
  ): Promise<T> {
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      const mailbox = client.mailbox;
      if (mailbox === false)
        throw new MailError('mailbox_not_found', `Mailbox "${path}" could not be opened.`);
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
    return this.#withMailbox(client, path, async (uidValidity) => {
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
    const query: FetchQueryObject = {
      ...this.#summaryQuery(),
      bodyStructure: true,
      source: format !== 'metadata',
    };
    const fetched = await client.fetchAll(uids.join(','), query, { uid: true });
    const byUid = new Map(fetched.map((msg) => [msg.uid, msg]));
    const details: MessageDetail[] = [];
    for (const uid of uids) {
      const msg = byUid.get(uid);
      if (msg === undefined) continue;
      const body =
        format === 'metadata' || msg.source === undefined
          ? null
          : await renderBody(msg.source, format);
      details.push({
        ...this.#summary(path, uidValidity, msg),
        messageIdHeader: msg.envelope?.messageId ?? null,
        inReplyTo: msg.envelope?.inReplyTo ?? null,
        attachments: collectAttachments(msg.bodyStructure),
        format,
        body,
      });
    }
    return details;
  }

  #summary(path: string, uidValidity: string, msg: FetchMessageObject): MessageSummary {
    return {
      id: encodeMessageId({ account: this.account.id, mailbox: path, uidValidity, uid: msg.uid }),
      threadId: this.#threadId(path, msg),
      account: this.account.id,
      mailbox: path,
      date: messageDate(msg),
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

function sortedUids(found: number[] | false | undefined, order: 'asc' | 'desc'): number[] {
  const uids = found === false || found === undefined ? [] : [...found];
  return uids.sort((a, b) => (order === 'asc' ? a - b : b - a));
}
