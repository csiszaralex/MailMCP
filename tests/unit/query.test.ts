import { describe, expect, it } from 'vitest';
import { translateQuery } from '../../src/search/query.js';
import { MailError } from '../../src/errors.js';

function expectUnsupported(query: string, fragment: string): void {
  try {
    translateQuery(query);
  } catch (err) {
    expect(err).toBeInstanceOf(MailError);
    if (err instanceof MailError) {
      expect(err.code).toBe('unsupported_query');
      expect(err.message).toContain(fragment);
    }
    return;
  }
  throw new Error(`expected "${query}" to be rejected`);
}

describe('translateQuery', () => {
  it('maps an empty query to all messages in the inbox', () => {
    expect(translateQuery('  ')).toEqual({ mailbox: { kind: 'inbox' }, criteria: { all: true } });
  });

  it('maps address and subject operators, with quoted values', () => {
    expect(
      translateQuery('from:bob@example.com subject:"quarterly report" cc:c@example.org').criteria,
    ).toEqual({
      from: 'bob@example.com',
      subject: 'quarterly report',
      cc: 'c@example.org',
    });
  });

  it('maps dates to since/before at UTC midnight', () => {
    expect(translateQuery('after:2026/11/01 before:2026-11-05').criteria).toEqual({
      since: new Date(Date.UTC(2026, 10, 1)),
      before: new Date(Date.UTC(2026, 10, 5)),
    });
  });

  it('maps is: flags', () => {
    expect(translateQuery('is:unread is:starred').criteria).toEqual({ seen: false, flagged: true });
    expect(translateQuery('is:read is:unstarred').criteria).toEqual({ seen: true, flagged: false });
  });

  it('approximates has:attachment with multipart/mixed', () => {
    expect(translateQuery('has:attachment').criteria).toEqual({
      header: { 'content-type': 'multipart/mixed' },
    });
  });

  it('joins free words into one text phrase and ignores AND', () => {
    expect(translateQuery('invoice AND "march 2026"').criteria).toEqual({
      text: 'invoice march 2026',
    });
  });

  it('selects mailboxes with in:', () => {
    expect(translateQuery('in:sent').mailbox).toEqual({ kind: 'special', use: '\\Sent' });
    expect(translateQuery('in:drafts').mailbox).toEqual({ kind: 'special', use: '\\Drafts' });
    expect(translateQuery('in:trash').mailbox).toEqual({ kind: 'special', use: '\\Trash' });
    expect(translateQuery('in:spam').mailbox).toEqual({ kind: 'special', use: '\\Junk' });
    expect(translateQuery('in:inbox').mailbox).toEqual({ kind: 'inbox' });
    expect(translateQuery('in:"Projects/2026"').mailbox).toEqual({
      kind: 'path',
      path: 'Projects/2026',
    });
  });

  it('treats unknown word: tokens and URLs as free text', () => {
    expect(translateQuery('re:hello https://example.org/a').criteria).toEqual({
      text: 're:hello https://example.org/a',
    });
  });

  it('maps in:all and in:anywhere to the \\All mailbox', () => {
    expect(translateQuery('in:all').mailbox).toEqual({ kind: 'special', use: '\\All' });
    expect(translateQuery('in:anywhere').mailbox).toEqual({ kind: 'special', use: '\\All' });
  });

  it('rejects what plain IMAP cannot express', () => {
    expectUnsupported('from:a OR from:b', 'OR');
    expectUnsupported('-from:a', 'negation');
    expectUnsupported('subject:(a b)', 'grouping');
    expectUnsupported('newer_than:7d', 'newer_than');
    expectUnsupported('label:work', 'label');
    expectUnsupported('larger:5M', 'larger');
    expectUnsupported('category:promotions', 'category');
    expectUnsupported('has:drive', 'has:drive');
    expectUnsupported('is:important', 'is:important');
    expectUnsupported('from:a from:b', 'more than once');
    expectUnsupported('after:2026/13/01', 'date');
  });
});
