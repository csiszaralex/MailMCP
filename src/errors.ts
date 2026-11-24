export type MailErrorCode =
  | 'config_invalid'
  | 'unknown_account'
  | 'invalid_id'
  | 'stale_id'
  | 'not_found'
  | 'mailbox_not_found'
  | 'unsupported_query'
  /** The mail server answered NO or BAD to a SEARCH it was sent. */
  | 'search_failed'
  | 'too_large'
  /** The tool does not offer this format (raw is per message only). */
  | 'unsupported_format'
  | 'connection_failed'
  /** The account's access level is too low for this tool. */
  | 'not_permitted'
  /** The mail server lacks a capability the tool needs. */
  | 'unsupported_server'
  /** The SMTP server refused or failed to send the message. */
  | 'send_failed'
  /** The IMAP server refused a flag, label or move change; changes stored before it are kept. */
  | 'update_failed';

/** An expected failure whose message is safe to show to the MCP client. */
export class MailError extends Error {
  readonly code: MailErrorCode;

  constructor(code: MailErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MailError';
    this.code = code;
  }
}

/** Shown instead of the message of any error that is not a MailError. */
export const INTERNAL_ERROR_MESSAGE = 'Internal error while talking to the mail server.';

export type ClientErrorCode = MailErrorCode | 'internal';

export interface ClientError {
  code: ClientErrorCode;
  message: string;
}

/** What a client may see of a failure: a MailError as written, anything else as a generic internal error. */
export function clientError(err: MailError | undefined): ClientError {
  return err === undefined
    ? { code: 'internal', message: INTERNAL_ERROR_MESSAGE }
    : { code: err.code, message: err.message };
}
