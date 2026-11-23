import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { Account } from '../../src/config/types.js';
import type { ImapClientFactory } from '../../src/imap/client.js';
import type { SmtpSend } from '../../src/smtp/sender.js';

export const GREENMAIL_IMAGE = 'greenmail/standalone:2.1.15';
const IMAP_PORT = 3143;
const SMTP_PORT = 3025;
const PASSWORD = 'secret';

export interface GreenMail {
  container: StartedTestContainer;
  /** alice@example.com */
  account: Account;
  /** bob@example.com, on the same server. */
  bob: Account;
  smtpPort: number;
  /** Plaintext SMTP with the sending account's password: only tests may send without TLS. */
  send: SmtpSend;
  /** Plaintext factory with the right password: only tests may connect without TLS. */
  connect: ImapClientFactory;
  /** The same factory with any password, to test rejected logins. */
  connectAs: (password: string) => ImapClientFactory;
}

function testAccount(
  id: string,
  user: string,
  host: string,
  imapPort: number,
  smtpPort: number,
): Account {
  return {
    id,
    owner: 'alex',
    address: `${user}@example.com`,
    username: user,
    provider: 'imap',
    level: 'read',
    signature: undefined,
    imap: { host, port: imapPort },
    smtp: { host, port: smtpPort },
    mailboxes: {},
  };
}

export async function startGreenMail(): Promise<GreenMail> {
  const container = await new GenericContainer(GREENMAIL_IMAGE)
    .withEnvironment({
      GREENMAIL_OPTS:
        '-Dgreenmail.setup.test.imap -Dgreenmail.setup.test.smtp -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=alice:secret@example.com,bob:secret@example.com',
    })
    .withExposedPorts(IMAP_PORT, SMTP_PORT)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(IMAP_PORT);
  const smtpPort = container.getMappedPort(SMTP_PORT);
  const account = testAccount('test', 'alice', host, port, smtpPort);
  const bob = testAccount('bob', 'bob', host, port, smtpPort);
  const connectAs =
    (password: string): ImapClientFactory =>
    async (acc) => {
      const client = new ImapFlow({
        host: acc.imap.host,
        port: acc.imap.port,
        secure: false,
        doSTARTTLS: false,
        auth: { user: acc.username, pass: password },
        logger: false,
        disableAutoIdle: true,
      });
      await client.connect();
      return client;
    };
  const send: SmtpSend = async (acc, raw, envelope) => {
    const transport = createTransport({
      host: acc.smtp.host,
      port: acc.smtp.port,
      secure: false,
      ignoreTLS: true,
      auth: { user: acc.username, pass: PASSWORD },
    });
    try {
      await transport.sendMail({ envelope: { from: envelope.from, to: envelope.to }, raw });
    } finally {
      transport.close();
    }
  };
  return { container, account, bob, smtpPort, send, connect: connectAs(PASSWORD), connectAs };
}

function mail(lines: string[]): Buffer {
  return Buffer.from(lines.join('\r\n'));
}

/** A 1x1 PNG, enough for mailparser to inline it as a data: URI if asked to. */
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Seeds INBOX with three messages (uid 1..3); Drafts, Newsletters and Forwards with one each. */
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

  await client.mailboxCreate('Forwards');
  await client.append(
    'Forwards',
    mail([
      'From: alice@example.com',
      'To: dave@example.com',
      'Subject: Fwd: Inner note',
      'Date: Sat, 14 Nov 2026 08:00:00 +0000',
      'Message-ID: <f1@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="fwd"',
      '',
      '--fwd',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'See the forwarded mail.',
      '--fwd',
      'Content-Type: message/rfc822',
      'Content-Disposition: attachment; filename="inner.eml"',
      '',
      'From: Carol <carol@example.com>',
      'To: alice@example.com',
      'Subject: Inner note',
      'Message-ID: <i1@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Inner body.',
      '--fwd--',
      '',
    ]),
  );

  await client.logout();
}
