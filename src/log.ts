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
  durationMs: number;
}

export type Logger = (record: LogRecord) => void;

/** What a tool call targeted, as far as the log may say. */
export type LogTarget = Pick<LogRecord, 'account' | 'id'>;

/** One JSON line per tool call. Never put mail content, passwords or tokens in a record. */
export const stderrLogger: Logger = (record) => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`);
};
