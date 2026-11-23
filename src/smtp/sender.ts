import { createTransport } from 'nodemailer';
import type { SMTPTransportOptions } from 'nodemailer';
import { protocolDebugLogger } from '../boundary.js';
import type { Account, PasswordLookup } from '../config/types.js';
import { MailError } from '../errors.js';

export interface Envelope {
  from: string;
  to: string[];
}

/** Sends an already composed RFC 5322 message; the envelope decides who receives it. */
export type SmtpSend = (account: Account, raw: Buffer, envelope: Envelope) => Promise<void>;

/** Budget for TCP, TLS and the greeting of a new connection. */
export const SMTP_CONNECTION_TIMEOUT_MS = 15_000;
/** A server silent this long is treated as stalled. */
export const SMTP_SOCKET_TIMEOUT_MS = 60_000;

/** TLS is mandatory and certificate checks cannot be turned off: 465 is implicit TLS, anything else must STARTTLS. */
export function smtpTransportOptions(
  account: Account,
  password: string,
  debug: boolean,
): SMTPTransportOptions {
  const implicitTls = account.smtp.port === 465;
  return {
    host: account.smtp.host,
    port: account.smtp.port,
    secure: implicitTls,
    ...(implicitTls ? {} : { requireTLS: true }),
    auth: { user: account.username, pass: password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
    ...(debug
      ? { logger: protocolDebugLogger('smtp', account.id), debug: true }
      : { logger: false }),
  };
}

/** The production sender: a fresh TLS transport per call, passwords from the lookup loadConfig built. */
export function tlsSmtpSender(passwordFor: PasswordLookup, debug: boolean): SmtpSend {
  return async (account, raw, envelope) => {
    const transport = createTransport(
      smtpTransportOptions(account, passwordFor(account.id), debug),
    );
    try {
      await transport.sendMail({ envelope: { from: envelope.from, to: envelope.to }, raw });
    } catch (err) {
      // The server's reply text may contain addresses, so only codes go into the message.
      const detail: string[] = [];
      if (err instanceof Error) {
        if ('code' in err && typeof err.code === 'string') detail.push(`code ${err.code}`);
        if ('responseCode' in err && typeof err.responseCode === 'number') {
          detail.push(`response ${String(err.responseCode)}`);
        }
      }
      const suffix = detail.length > 0 ? ` (${detail.join(', ')})` : '';
      throw new MailError(
        'send_failed',
        `Sending through ${account.smtp.host} failed for account ${account.id}${suffix}.`,
        { cause: err },
      );
    } finally {
      transport.close();
    }
  };
}
