import type { SearchObject } from 'imapflow';
import { MailError } from '../errors.js';

export type SpecialUse = '\\All' | '\\Drafts' | '\\Sent' | '\\Trash' | '\\Junk';

export type MailboxSelector =
  { kind: 'inbox' } | { kind: 'special'; use: SpecialUse } | { kind: 'path'; path: string };

export interface ImapQuery {
  mailbox: MailboxSelector;
  criteria: SearchObject;
}

const GMAIL_ONLY = 'is only supported on Gmail accounts';

const IN_ALIASES: Record<string, MailboxSelector> = {
  inbox: { kind: 'inbox' },
  sent: { kind: 'special', use: '\\Sent' },
  drafts: { kind: 'special', use: '\\Drafts' },
  draft: { kind: 'special', use: '\\Drafts' },
  trash: { kind: 'special', use: '\\Trash' },
  bin: { kind: 'special', use: '\\Trash' },
  spam: { kind: 'special', use: '\\Junk' },
  junk: { kind: 'special', use: '\\Junk' },
};

function unsupported(message: string): MailError {
  return new MailError('unsupported_query', message);
}

/** Splits on whitespace but keeps "quoted phrases" (also after an operator) together. */
function tokenize(query: string): string[] {
  return query.match(/[^\s"]*"[^"]*"|\S+/g) ?? [];
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function parseDate(value: string): Date {
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
  if (match === null) throw unsupported(`"${value}" is not a date; use YYYY/MM/DD`);
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) {
    throw unsupported(`"${value}" is not a valid date`);
  }
  return date;
}

export function translateQuery(query: string): ImapQuery {
  const criteria: SearchObject = {};
  const used = new Set<string>();
  const words: string[] = [];
  let mailbox: MailboxSelector = { kind: 'inbox' };

  const once = (key: string): void => {
    if (used.has(key))
      throw unsupported(`"${key}" can be used more than once only on Gmail accounts`);
    used.add(key);
  };

  for (const token of tokenize(query)) {
    if (token === 'AND') continue;
    if (token === 'OR' || token === '|') throw unsupported(`OR ${GMAIL_ONLY}`);
    if (token.startsWith('-')) throw unsupported(`negation ("${token}") ${GMAIL_ONLY}`);
    if (/[(){}]/.test(token.replace(/"[^"]*"/g, ''))) {
      throw unsupported(`grouping with brackets ${GMAIL_ONLY}`);
    }

    const operator = /^([a-z_]+):(.+)$/i.exec(token);
    if (operator === null) {
      words.push(unquote(token));
      continue;
    }
    const name = (operator[1] ?? '').toLowerCase();
    const value = unquote(operator[2] ?? '');

    switch (name) {
      case 'from':
      case 'to':
      case 'cc':
      case 'subject':
        once(name);
        criteria[name] = value;
        break;
      case 'after':
        once('after');
        criteria.since = parseDate(value);
        break;
      case 'before':
        once('before');
        criteria.before = parseDate(value);
        break;
      case 'is': {
        const flag = value.toLowerCase();
        if (flag === 'unread' || flag === 'read') {
          once('is:read');
          criteria.seen = flag === 'read';
        } else if (flag === 'starred' || flag === 'unstarred') {
          once('is:starred');
          criteria.flagged = flag === 'starred';
        } else {
          throw unsupported(`is:${value} ${GMAIL_ONLY}`);
        }
        break;
      }
      case 'has':
        if (value.toLowerCase() !== 'attachment') throw unsupported(`has:${value} ${GMAIL_ONLY}`);
        once('has');
        criteria.header = { 'content-type': 'multipart/mixed' };
        break;
      case 'in':
        once('in');
        mailbox = IN_ALIASES[value.toLowerCase()] ?? { kind: 'path', path: value };
        break;
      default:
        throw unsupported(`${name}: ${GMAIL_ONLY}`);
    }
  }

  if (words.length > 0) criteria.text = words.join(' ');
  if (Object.keys(criteria).length === 0) criteria.all = true;
  return { mailbox, criteria };
}
