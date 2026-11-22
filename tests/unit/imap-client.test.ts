import { describe, expect, it } from 'vitest';
import { imapConnectionOptions } from '../../src/imap/client.js';
import type { Account } from '../../src/config/types.js';

function account(port: number): Account {
  return {
    id: 'a',
    owner: 'alex',
    address: 'a@example.org',
    username: 'a@example.org',
    provider: 'imap',
    level: 'read',
    signature: undefined,
    imap: { host: 'mail.example.org', port },
    smtp: { host: 'mail.example.org', port: 465 },
    mailboxes: {},
    password: 'secret',
  };
}

describe('imapConnectionOptions', () => {
  it('uses implicit TLS on 993 with certificate verification', () => {
    const options = imapConnectionOptions(account(993));
    expect(options).toMatchObject({
      host: 'mail.example.org',
      port: 993,
      secure: true,
      auth: { user: 'a@example.org', pass: 'secret' },
      tls: { rejectUnauthorized: true },
      logger: false,
    });
  });

  it('requires STARTTLS on any other port', () => {
    const options = imapConnectionOptions(account(143));
    expect(options.secure).toBe(false);
    expect(options.doSTARTTLS).toBe(true);
    expect(options.tls).toMatchObject({ rejectUnauthorized: true });
  });
});
