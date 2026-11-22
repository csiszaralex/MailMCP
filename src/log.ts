export interface LogRecord {
  tool: string;
  account: string | null;
  outcome: 'ok' | 'error';
  code: string | null;
  durationMs: number;
}

export type Logger = (record: LogRecord) => void;

/** One JSON line per tool call. Never put mail content, passwords or tokens in a record. */
export const stderrLogger: Logger = (record) => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`);
};
