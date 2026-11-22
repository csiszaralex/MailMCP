import { ImapFlow } from 'imapflow';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { Account } from '../../src/config/types.js';
import type { ImapClientFactory } from '../../src/imap/client.js';

export const GREENMAIL_IMAGE = 'greenmail/standalone:2.1.15';
const IMAP_PORT = 3143;

export interface GreenMail {
  container: StartedTestContainer;
  account: Account;
  /** Plaintext factory: only tests may connect without TLS. */
  connect: ImapClientFactory;
}

export async function startGreenMail(): Promise<GreenMail> {
  const container = await new GenericContainer(GREENMAIL_IMAGE)
    .withEnvironment({
      GREENMAIL_OPTS:
        '-Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=alice:secret@example.com',
    })
    .withExposedPorts(IMAP_PORT)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(IMAP_PORT);
  const account: Account = {
    id: 'test',
    owner: 'alex',
    address: 'alice@example.com',
    username: 'alice',
    provider: 'imap',
    level: 'read',
    signature: undefined,
    imap: { host, port },
    smtp: { host, port: 3025 },
    mailboxes: {},
    password: 'secret',
  };
  const connect: ImapClientFactory = async (acc) => {
    const client = new ImapFlow({
      host: acc.imap.host,
      port: acc.imap.port,
      secure: false,
      doSTARTTLS: false,
      auth: { user: acc.username, pass: acc.password },
      logger: false,
      disableAutoIdle: true,
    });
    await client.connect();
    return client;
  };
  return { container, account, connect };
}

function mail(lines: string[]): Buffer {
  return Buffer.from(lines.join('\r\n'));
}

/** A 1x1 PNG, enough for mailparser to inline it as a data: URI if asked to. */
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Seeds INBOX with three messages (uid 1..3), Drafts with one and Newsletters with one. */
export async function seed(gm: GreenMail): Promise<void> {
  const client = new ImapFlow({
    host: gm.account.imap.host,
    port: gm.account.imap.port,
    secure: false,
    doSTARTTLS: false,
    auth: { user: 'alice', pass: 'secret' },
    logger: false,
  });
  await client.connect();
  await client.mailboxCreate('Drafts');

  await client.append(
    'INBOX',
    mail([
      'From: Bob <bob@example.com>',
      'To: alice@example.com',
      'Subject: Invoice 2026-11',
      'Date: Tue, 10 Nov 2026 08:00:00 +0000',
      'Message-ID: <m1@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="mix"',
      '',
      '--mix',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Please find the invoice attached.',
      '--mix',
      'Content-Type: application/pdf; name="invoice.pdf"',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('fake pdf bytes').toString('base64'),
      '--mix--',
      '',
    ]),
    ['\\Seen'],
    new Date('2026-11-10T08:00:00Z'),
  );

  await client.append(
    'INBOX',
    mail([
      'From: alice@example.com',
      'To: Bob <bob@example.com>',
      'Subject: Re: Invoice 2026-11',
      'Date: Wed, 11 Nov 2026 09:00:00 +0000',
      'Message-ID: <m2@example.com>',
      'In-Reply-To: <m1@example.com>',
      'References: <m1@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Thanks, paid.',
      '',
    ]),
    ['\\Seen'],
    new Date('2026-11-11T09:00:00Z'),
  );

  await client.append(
    'INBOX',
    mail([
      'From: Carol <carol@example.com>',
      'To: alice@example.com',
      'Subject: Lunch?',
      'Date: Thu, 12 Nov 2026 10:00:00 +0000',
      'Message-ID: <m3@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Lunch at <b>noon</b>?</p>',
      '',
    ]),
    [],
    new Date('2026-11-12T10:00:00Z'),
  );

  await client.append(
    'Drafts',
    mail([
      'From: alice@example.com',
      'To: dave@example.com',
      'Subject: Draft note',
      'Message-ID: <d1@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Not finished yet.',
      '',
    ]),
    ['\\Draft'],
  );

  await client.mailboxCreate('Newsletters');
  await client.append(
    'Newsletters',
    mail([
      'From: News <news@example.org>',
      'To: alice@example.com',
      'Subject: Monthly news',
      'Date: Fri, 13 Nov 2026 07:00:00 +0000',
      'Message-ID: <n1@example.org>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="rel"',
      '',
      '--rel',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p><img src="cid:logo@example.org"> News of the month</p>',
      '--rel',
      'Content-Type: image/png',
      'Content-ID: <logo@example.org>',
      'Content-Disposition: inline',
      'Content-Transfer-Encoding: base64',
      '',
      PIXEL_PNG,
      '--rel--',
      '',
    ]),
    ['\\Seen'],
    new Date('2026-11-13T07:00:00Z'),
  );

  await client.logout();
}
