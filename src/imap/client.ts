import { ImapFlow } from 'imapflow';
import { protocolDebugLogger } from '../boundary.js';
import type {
  AppendResponseObject,
  CopyResponseObject,
  DownloadNotFound,
  DownloadObject,
  DownloadOptions,
  FetchMessageObject,
  FetchQueryObject,
  ImapFlowOptions,
  ListResponse,
  MailboxCreateResponse,
  MailboxDeleteResponse,
  MailboxLockObject,
  MailboxLockOptions,
  MailboxObject,
  MailboxRenameResponse,
  MessageRange,
  MessageRangeOptions,
  SearchObject,
  StatusObject,
  StatusQuery,
  StoreOptions,
} from 'imapflow';
import type { Account, PasswordLookup } from '../config/types.js';

/**
 * The part of ImapFlow this project uses. Narrow on purpose: tests can fake it,
 * and an ImapFlow instance satisfies it structurally.
 */
export interface ImapClient {
  readonly usable: boolean;
  readonly mailbox: MailboxObject | false;
  /** Active server capabilities: `true` for toggles (UIDPLUS), a number for valued ones (APPENDLIMIT). */
  readonly capabilities: Map<string, boolean | number>;
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
  append(
    path: string,
    content: string | Buffer | Uint8Array,
    flags?: string[],
    idate?: Date | string,
  ): Promise<AppendResponseObject | false>;
  messageMove(
    range: MessageRange,
    destination: string,
    options: MessageRangeOptions,
  ): Promise<CopyResponseObject | false>;
  messageFlagsAdd(range: MessageRange, flags: string[], options: StoreOptions): Promise<boolean>;
  messageFlagsRemove(range: MessageRange, flags: string[], options: StoreOptions): Promise<boolean>;
  messageDelete(range: MessageRange, options: MessageRangeOptions): Promise<boolean>;
  mailboxCreate(path: string): Promise<MailboxCreateResponse>;
  mailboxRename(path: string, newPath: string): Promise<MailboxRenameResponse>;
  mailboxDelete(path: string): Promise<MailboxDeleteResponse>;
  status(path: string, query: StatusQuery): Promise<StatusObject | false>;
  on(event: 'close', listener: () => void): void;
  /** imapflow emits 'error' after connect too; without a listener Node would crash the process. */
  on(event: 'error', listener: (err: Error) => void): void;
  logout(): Promise<void>;
}

export type ImapClientFactory = (account: Account) => Promise<ImapClient>;

/** Budget for TCP, TLS and the greeting of a new connection. */
export const CONNECTION_TIMEOUT_MS = 15_000;
/** The pool logs out a connection after this long without use. */
export const IDLE_CLOSE_MS = 60_000;
/**
 * A server silent this long is treated as stalled (imapflow default: 5 min). It must stay above
 * IDLE_CLOSE_MS: imapflow also counts an idle connection's silence, and a timeout first would
 * break every idle connection with ETIMEOUT instead of the pool's clean logout.
 */
export const SOCKET_TIMEOUT_MS = 2 * IDLE_CLOSE_MS;

/** TLS is mandatory and certificate checks cannot be turned off (spec: "Levelezőszerverek felé"). */
export function imapConnectionOptions(
  account: Account,
  password: string,
  debug: boolean,
): ImapFlowOptions {
  const implicitTls = account.imap.port === 993;
  return {
    host: account.imap.host,
    port: account.imap.port,
    secure: implicitTls,
    doSTARTTLS: implicitTls ? undefined : true,
    auth: { user: account.username, pass: password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    logger: debug ? protocolDebugLogger('imap', account.id) : false,
    disableAutoIdle: true,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  };
}

/** The production factory: TLS connections, passwords from the lookup loadConfig built. */
export function tlsConnector(passwordFor: PasswordLookup, debug: boolean): ImapClientFactory {
  return async (account) => {
    const client = new ImapFlow(imapConnectionOptions(account, passwordFor(account.id), debug));
    await client.connect();
    return client;
  };
}
