import { describe, expect, it } from 'vitest';
import type { ListResponse } from 'imapflow';
import { resolveMailbox } from '../../src/imap/mailboxes.js';
import type { ImapClient } from '../../src/imap/client.js';
import { MailError } from '../../src/errors.js';

function clientWith(boxes: Partial<ListResponse>[]): ImapClient {
  return {
    list: () => Promise.resolve(boxes as ListResponse[]),
  } as Partial<ImapClient> as ImapClient;
}

describe('resolveMailbox', () => {
  const gmail = clientWith([
    { path: 'INBOX' },
    { path: '[Gmail]/Összes levél', specialUse: '\\All' },
    { path: '[Gmail]/Piszkozatok', specialUse: '\\Drafts' },
  ]);

  it('returns INBOX and explicit paths without listing', async () => {
    expect(await resolveMailbox(gmail, { kind: 'inbox' }, {})).toBe('INBOX');
    expect(await resolveMailbox(gmail, { kind: 'path', path: 'X/Y' }, {})).toBe('X/Y');
  });

  it('finds special-use mailboxes by flag, whatever their localized name', async () => {
    expect(await resolveMailbox(gmail, { kind: 'special', use: '\\All' }, {})).toBe(
      '[Gmail]/Összes levél',
    );
  });

  it('prefers the configured override', async () => {
    expect(await resolveMailbox(gmail, { kind: 'special', use: '\\Junk' }, { junk: 'Spam' })).toBe(
      'Spam',
    );
  });

  it('resolves the archive override and explains a missing archive mailbox', async () => {
    expect(
      await resolveMailbox(gmail, { kind: 'special', use: '\\Archive' }, { archive: 'Old' }),
    ).toBe('Old');
    const result = resolveMailbox(gmail, { kind: 'special', use: '\\Archive' }, {});
    await expect(result).rejects.toMatchObject({ code: 'mailbox_not_found' });
    await expect(result).rejects.toThrow('mailboxes.archive');
  });

  it('explains how to fix a missing special mailbox', async () => {
    const result = resolveMailbox(gmail, { kind: 'special', use: '\\Junk' }, {});
    await expect(result).rejects.toBeInstanceOf(MailError);
    await expect(result).rejects.toThrow('mailboxes.junk');
  });
});
