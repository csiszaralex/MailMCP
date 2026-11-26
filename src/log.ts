/**
 * Sanitized description of an unexpected error: its class and codes, never its message text
 * (which may carry server text). responseStatus and serverResponseCode are set by imapflow.
 */
export interface ErrorClass {
  name: string;
  code: string | null;
  responseStatus: string | null;
  serverResponseCode: string | null;
}

export function errorClass(err: Error): ErrorClass {
  return {
    name: err.name,
    code: 'code' in err && typeof err.code === 'string' ? err.code : null,
    responseStatus:
      'responseStatus' in err && typeof err.responseStatus === 'string' ? err.responseStatus : null,
    serverResponseCode:
      'serverResponseCode' in err && typeof err.serverResponseCode === 'string'
        ? err.serverResponseCode
        : null,
  };
}

export interface LogRecord {
  tool: string;
  account: string | null;
  /**
   * The opaque message or thread id the call targeted. null when the call has none, the id is
   * invalid, or it is a thread id that embeds a Message-ID header (never logged).
   */
  id: string | null;
  outcome: 'ok' | 'error';
  code: string | null;
  /** Set for failures that are not an expected MailError, or for a MailError's underlying cause. */
  error: ErrorClass | null;
  durationMs: number;
}

export type Logger = (record: LogRecord) => void;

/** What a tool call targeted, as far as the log may say. */
export type LogTarget = Pick<LogRecord, 'account' | 'id'>;

/** An 'error' event of an open IMAP connection (logged once per connection). */
export interface ConnectionErrorRecord {
  event: 'connection_error';
  account: string;
  error: ErrorClass;
}

export type ConnectionLogger = (record: ConnectionErrorRecord) => void;

/** One OAuth event (D37). Never a token, code, password or TOTP code. */
export interface AuthEventRecord {
  event:
    | 'login_ok'
    | 'login_failed'
    | 'login_blocked'
    | 'authorize_rejected'
    | 'token_issued'
    | 'token_refreshed'
    | 'refresh_reuse'
    | 'code_reuse';
  /** Host of the client_id URL. */
  client: string | null;
  resource: string | null;
  /** The client address as clientIp gives it (D34); 'unknown' when there is none. */
  ip: string;
  /** Short fixed text, never user input. */
  reason: string | null;
}

export type AuthLogger = (record: AuthEventRecord) => void;

/** One JSON line per record. Never put mail content, passwords or tokens in a record. */
function writeLine(record: LogRecord | ConnectionErrorRecord | AuthEventRecord): void {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`);
}

export const stderrLogger: Logger = writeLine;
export const stderrConnectionLogger: ConnectionLogger = writeLine;
export const stderrAuthLogger: AuthLogger = writeLine;
