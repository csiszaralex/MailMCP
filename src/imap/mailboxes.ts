import type { MailboxOverrides } from '../config/types.js';
import { MailError } from '../errors.js';
import type { MailboxSelector, SpecialUse } from '../search/query.js';
import type { ImapClient } from './client.js';

const OVERRIDE_KEY: Record<SpecialUse, keyof MailboxOverrides> = {
  '\\All': 'all',
  '\\Drafts': 'drafts',
  '\\Sent': 'sent',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
};

export async function resolveMailbox(
  client: ImapClient,
  selector: MailboxSelector,
  overrides: MailboxOverrides,
): Promise<string> {
  switch (selector.kind) {
    case 'inbox':
      return 'INBOX';
    case 'path':
      return selector.path;
    case 'special': {
      const key = OVERRIDE_KEY[selector.use];
      const override = overrides[key];
      if (override !== undefined) return override;
      const match = (await client.list()).find((box) => box.specialUse === selector.use);
      if (match !== undefined) return match.path;
      throw new MailError(
        'mailbox_not_found',
        `No ${selector.use} mailbox found on the server; set mailboxes.${key} for this account in accounts.yaml.`,
      );
    }
  }
}
