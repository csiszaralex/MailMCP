import { ImapFlow } from 'imapflow';
import type {
  DownloadNotFound,
  DownloadObject,
  DownloadOptions,
  FetchMessageObject,
  FetchQueryObject,
  ImapFlowOptions,
  ListResponse,
  MailboxLockObject,
  MailboxLockOptions,
  MailboxObject,
  SearchObject,
} from 'imapflow';
import type { Account } from '../config/types.js';

/**
 * The part of ImapFlow this project uses. Narrow on purpose: tests can fake it,
 * and an ImapFlow instance satisfies it structurally.
 */
export interface ImapClient {
  readonly usable: boolean;
  readonly mailbox: MailboxObject | false;
  list(): Promise<ListResponse[]>;
  getMailboxLock(path: string, options?: MailboxLockOptions): Promise<MailboxLockObject>;
  search(query: SearchObject, options: { uid: true }): Promise<number[] | false | undefined>;
  fetchAll(
    range: string,
    query: FetchQueryObject,
    options: { uid: true },
  ): Promise<FetchMessageObject[]>;
  fetchOne(
    uid: string,
    query: FetchQueryObject,
    options: { uid: true },
  ): Promise<FetchMessageObject | false>;
  download(
    uid: string,
    part: string,
    options: DownloadOptions,
  ): Promise<DownloadObject | DownloadNotFound>;
  /** imapflow emits 'error' after connect too; without a listener Node would crash the process. */
  on(event: 'close' | 'error', listener: () => void): void;
  logout(): Promise<void>;
}

export type ImapClientFactory = (account: Account) => Promise<ImapClient>;

/** TLS is mandatory and certificate checks cannot be turned off (spec: "Levelezőszerverek felé"). */
export function imapConnectionOptions(account: Account): ImapFlowOptions {
  const implicitTls = account.imap.port === 993;
  return {
    host: account.imap.host,
    port: account.imap.port,
    secure: implicitTls,
    doSTARTTLS: implicitTls ? undefined : true,
    auth: { user: account.username, pass: account.password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15_000,
  };
}

export const connectTls: ImapClientFactory = async (account) => {
  const client = new ImapFlow(imapConnectionOptions(account));
  await client.connect();
  return client;
};
