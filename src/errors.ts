export type MailErrorCode =
  | 'config_invalid'
  | 'unknown_account'
  | 'invalid_id'
  | 'stale_id'
  | 'not_found'
  | 'mailbox_not_found'
  | 'unsupported_query'
  | 'too_large'
  | 'connection_failed';

/** An expected failure whose message is safe to show to the MCP client. */
export class MailError extends Error {
  readonly code: MailErrorCode;

  constructor(code: MailErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MailError';
    this.code = code;
  }
}
