import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startGreenMail, type GreenMail } from './greenmail.js';

let gm: GreenMail;

beforeAll(async () => {
  gm = await startGreenMail();
});

afterAll(async () => {
  await gm.container.stop();
});

describe('GreenMail SMTP helper', () => {
  it('delivers a raw message from alice to bob', async () => {
    const raw = Buffer.from(
      [
        'From: alice@example.com',
        'To: bob@example.com',
        'Subject: Hello Bob',
        'Message-ID: <s1@example.com>',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Hi.',
        '',
      ].join('\r\n'),
    );
    await gm.send(gm.account, raw, { from: 'alice@example.com', to: ['bob@example.com'] });

    const client = await gm.connect(gm.bob);
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const found = await client.search({ subject: 'Hello Bob' }, { uid: true });
        expect(found).toHaveLength(1);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  });
});
