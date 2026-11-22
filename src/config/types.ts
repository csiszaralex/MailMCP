import type { AccessLevel, MailboxOverrides } from './schema.js';

export type { AccessLevel, MailboxOverrides };

export interface Endpoint {
  host: string;
  port: number;
}

export interface Account {
  id: string;
  owner: string;
  address: string;
  /** IMAP/SMTP login name; defaults to the address. */
  username: string;
  provider: 'gmail' | 'imap';
  level: AccessLevel;
  signature: string | undefined;
  imap: Endpoint;
  smtp: Endpoint;
  mailboxes: MailboxOverrides;
}

/** An account's IMAP/SMTP password. Kept out of Account, so code that gets accounts never holds it. */
export type PasswordLookup = (accountId: string) => string;

export interface Config {
  owner: string;
  accounts: Account[];
  /** Only for the connection factory; never hand it to the tool layer. */
  passwordFor: PasswordLookup;
}
