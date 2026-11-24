import { describe, expect, it } from 'vitest';
import { IDLE_CLOSE_MS, imapConnectionOptions, SOCKET_TIMEOUT_MS } from '../../src/imap/client.js';
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
  };
}

describe('imapConnectionOptions', () => {
  it('uses implicit TLS on 993 with certificate verification', () => {
    const options = imapConnectionOptions(account(993), 'secret', false);
    expect(options).toMatchObject({
      host: 'mail.example.org',
      port: 993,
      secure: true,
      auth: { user: 'a@example.org', pass: 'secret' },
      tls: { rejectUnauthorized: true },
      logger: false,
    });
  });

  it('gives up on a silent server instead of waiting five minutes', () => {
    expect(imapConnectionOptions(account(993), 'secret', false).socketTimeout).toBe(
      SOCKET_TIMEOUT_MS,
    );
    expect(SOCKET_TIMEOUT_MS).toBeLessThan(5 * 60_000);
  });

  it('keeps the socket timeout above the idle close, so idle connections log out cleanly', () => {
    expect(SOCKET_TIMEOUT_MS).toBeGreaterThan(IDLE_CLOSE_MS);
  });

  it('turns the protocol logger off unless debug is on', () => {
    expect(imapConnectionOptions(account(993), 'secret', false).logger).toBe(false);
  });

  it('routes the protocol log through a logger object when debug is on', () => {
    const { logger } = imapConnectionOptions(account(993), 'secret', true);
    expect(logger).toBeTypeOf('object');
    expect(logger).toHaveProperty('debug', expect.any(Function));
  });

  it('requires STARTTLS on any other port', () => {
    const options = imapConnectionOptions(account(143), 'secret', false);
    expect(options.secure).toBe(false);
    expect(options.doSTARTTLS).toBe(true);
    expect(options.tls).toMatchObject({ rejectUnauthorized: true });
  });
});
