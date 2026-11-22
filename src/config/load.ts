import * as z from 'zod';
import { parseYamlText } from '../boundary.js';
import { MailError } from '../errors.js';
import { configFileSchema } from './schema.js';
import type { Account, Config, Endpoint } from './types.js';

export const GMAIL_IMAP: Endpoint = { host: 'imap.gmail.com', port: 993 };
export const GMAIL_SMTP: Endpoint = { host: 'smtp.gmail.com', port: 465 };

export function passwordEnvName(accountId: string): string {
  return `MAILMCP_PASSWORD_${accountId.toUpperCase().replaceAll('-', '_')}`;
}

function invalid(details: string): MailError {
  return new MailError('config_invalid', `accounts.yaml is invalid:\n${details}`);
}

export function loadConfig(
  yamlText: string,
  env: Readonly<Record<string, string | undefined>>,
): Config {
  let raw;
  try {
    raw = parseYamlText(yamlText);
  } catch (err) {
    throw invalid(err instanceof Error ? err.message : 'YAML could not be parsed');
  }

  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) throw invalid(z.prettifyError(parsed.error));

  const problems: string[] = [];
  const seen = new Set<string>();
  const accounts: Account[] = [];

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
      password,
    });
  }

  if (problems.length > 0) throw invalid(`- ${problems.join('\n- ')}`);
  return { owner: parsed.data.owner, accounts };
}
