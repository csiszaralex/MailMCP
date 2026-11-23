import * as z from 'zod';
import { YAMLError } from 'yaml';
import { parseYamlText } from '../boundary.js';
import { MailError } from '../errors.js';
import { configFileSchema } from './schema.js';
import type { Account, Config, Endpoint } from './types.js';

export const GMAIL_IMAP: Endpoint = { host: 'imap.gmail.com', port: 993 };
export const GMAIL_SMTP: Endpoint = { host: 'smtp.gmail.com', port: 465 };

export function passwordEnvName(accountId: string): string {
  return `MAILMCP_PASSWORD_${accountId.toUpperCase().replaceAll('-', '_')}`;
}

export const DEFAULT_PORT = 8787;

/** MAILMCP_PORT: unset means DEFAULT_PORT; anything but a decimal 1-65535 stops the start. */
export function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = /^\d{1,5}$/.test(value) ? Number(value) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    throw new MailError(
      'config_invalid',
      `MAILMCP_PORT must be an integer from 1 to 65535, got "${value}".`,
    );
  }
  return port;
}

/** MAILMCP_DEBUG: unset or 0 is off, 1 is on; anything else stops the start. */
export function parseDebug(value: string | undefined): boolean {
  if (value === undefined || value === '0') return false;
  if (value === '1') return true;
  throw new MailError('config_invalid', `MAILMCP_DEBUG must be 0 or 1, got "${value}".`);
}

function invalid(details: string): MailError {
  return new MailError('config_invalid', `accounts.yaml is invalid:\n${details}`);
}

/** The YAML error's code and position only: its message quotes the line, which may hold an address. */
function yamlErrorText(err: Error | undefined): string {
  if (!(err instanceof YAMLError)) return 'YAML could not be parsed';
  const pos = err.linePos?.[0];
  const where = pos === undefined ? '' : ` at line ${String(pos.line)}, column ${String(pos.col)}`;
  return `YAML syntax error ${err.code}${where}`;
}

export function loadConfig(
  yamlText: string,
  env: Readonly<Record<string, string | undefined>>,
): Config {
  let raw;
  try {
    raw = parseYamlText(yamlText);
  } catch (err) {
    throw invalid(yamlErrorText(err instanceof Error ? err : undefined));
  }

  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) throw invalid(z.prettifyError(parsed.error));

  const problems: string[] = [];
  const seen = new Set<string>();
  const accounts: Account[] = [];
  const passwords = new Map<string, string>();

  for (const entry of parsed.data.accounts) {
    if (seen.has(entry.id)) problems.push(`duplicate account id "${entry.id}"`);
    seen.add(entry.id);

    const envName = passwordEnvName(entry.id);
    const password = env[envName];
    if (password === undefined || password === '') {
      problems.push(`missing password: set ${envName} for account "${entry.id}"`);
      continue;
    }

    accounts.push({
      id: entry.id,
      owner: parsed.data.owner,
      address: entry.address,
      username: entry.username ?? entry.address,
      provider: entry.provider,
      level: entry.level,
      signature: entry.signature,
      imap: entry.provider === 'gmail' ? GMAIL_IMAP : entry.imap,
      smtp: entry.provider === 'gmail' ? GMAIL_SMTP : entry.smtp,
      mailboxes: entry.mailboxes ?? {},
    });
    passwords.set(entry.id, password);
  }

  if (problems.length > 0) throw invalid(`- ${problems.join('\n- ')}`);
  const passwordFor = (accountId: string): string => {
    const password = passwords.get(accountId);
    if (password === undefined) throw new Error(`No password for account "${accountId}".`);
    return password;
  };
  return { owner: parsed.data.owner, accounts, passwordFor };
}
