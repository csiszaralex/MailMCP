/* eslint-disable no-restricted-syntax -- the single boundary where raw JSON/YAML enters a zod schema */
import { parse as parseYaml } from 'yaml';

export function parseJsonText(text: string): unknown {
  return JSON.parse(text) as unknown;
}

export function parseYamlText(text: string): unknown {
  return parseYaml(text) as unknown;
}

type DebugLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** A JSON.stringify replacer: bigint and Buffer would throw or bloat the line, a cycle would throw. */
function debugReplacer(): (this: Record<string, unknown>, key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return function (key, jsonValue) {
    // JSON.stringify calls toJSON first (a Buffer arrives as {type, data}); `this[key]` is the original.
    const value = this[key];
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Buffer) return `<${String(value.length)} bytes>`;
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '<circular>';
      seen.add(value);
    }
    return jsonValue;
  };
}

function debugLine(protocol: string, accountId: string, entry: unknown[]): string {
  const time = new Date().toISOString();
  try {
    return JSON.stringify({ time, debug: protocol, account: accountId, entry }, debugReplacer());
  } catch {
    // A throwing toJSON or getter: the logger must never break a mail operation.
    return JSON.stringify({
      time,
      debug: protocol,
      account: accountId,
      entry: ['<unserializable>'],
    });
  }
}

/**
 * A logger for imapflow and nodemailer (both hand over untyped arguments, nodemailer printf-style),
 * used only when MAILMCP_DEBUG=1. It writes one JSON line per call to stderr and may print mail
 * content by design.
 */
export function protocolDebugLogger(
  protocol: 'imap' | 'smtp',
  accountId: string,
): Record<DebugLevel, (...entry: unknown[]) => void> {
  const log =
    () =>
    (...entry: unknown[]): void => {
      process.stderr.write(`${debugLine(protocol, accountId, entry)}\n`);
    };
  return { trace: log(), debug: log(), info: log(), warn: log(), error: log(), fatal: log() };
}
