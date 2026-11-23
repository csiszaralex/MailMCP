import { describe, expect, it } from 'vitest';
import { assertLevel, levelAllows } from '../../src/config/levels.js';
import type { Account } from '../../src/config/types.js';

const account: Account = {
  id: 'personal',
  owner: 'alex',
  address: 'personal@example.com',
  username: 'personal@example.com',
  provider: 'gmail',
  level: 'send',
  signature: undefined,
  imap: { host: 'imap.example.com', port: 993 },
  smtp: { host: 'smtp.example.com', port: 465 },
  mailboxes: {},
};

describe('levelAllows', () => {
  it('orders read < draft < send', () => {
    expect(levelAllows('send', 'draft')).toBe(true);
    expect(levelAllows('draft', 'draft')).toBe(true);
    expect(levelAllows('draft', 'send')).toBe(false);
    expect(levelAllows('read', 'draft')).toBe(false);
  });
});

describe('assertLevel', () => {
  it('rejects a too low level with not_permitted', () => {
    expect(() => {
      assertLevel({ ...account, level: 'read' }, 'draft');
    }).toThrow(
      expect.objectContaining({
        code: 'not_permitted',
        message: 'Account "personal" has level read; this tool needs draft.',
      }),
    );
  });

  it('passes when the level is high enough', () => {
    expect(() => {
      assertLevel(account, 'send');
    }).not.toThrow();
  });
});
