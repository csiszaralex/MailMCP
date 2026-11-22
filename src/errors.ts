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
