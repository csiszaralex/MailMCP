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
  on(event: 'close', listener: () => void): void;
  /** imapflow emits 'error' after connect too; without a listener Node would crash the process. */
  on(event: 'error', listener: (err: Error) => void): void;
  logout(): Promise<void>;
}

export type ImapClientFactory = (account: Account) => Promise<ImapClient>;

/** Budget for TCP, TLS and the greeting of a new connection. */
export const CONNECTION_TIMEOUT_MS = 15_000;
/** A server silent this long in the middle of a command is treated as stalled (imapflow default: 5 min). */
export const SOCKET_TIMEOUT_MS = 60_000;

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
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  };
}

export const connectTls: ImapClientFactory = async (account) => {
  const client = new ImapFlow(imapConnectionOptions(account));
  await client.connect();
  return client;
};
