import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  decodeMessageId,
  decodeThreadId,
  encodeCursor,
  encodeMessageId,
  encodeThreadId,
} from '../../src/ids.js';
import { MailError } from '../../src/errors.js';

function expectInvalid(run: () => void): void {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(MailError);
    if (err instanceof MailError) expect(err.code).toBe('invalid_id');
    return;
  }
  throw new Error('expected invalid_id');
}

describe('message ids', () => {
  it('round-trips, including non-ASCII mailbox names', () => {
    const ref = { account: 'personal', mailbox: '[Gmail]/Összes levél', uidValidity: '7', uid: 42 };
    const id = encodeMessageId(ref);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeMessageId(id)).toEqual(ref);
  });

  it('rejects garbage and tampered payloads', () => {
    expectInvalid(() => decodeMessageId('not an id'));
    expectInvalid(() => decodeMessageId(Buffer.from('{"v":1}').toString('base64url')));
    expectInvalid(() =>
      decodeMessageId(
        Buffer.from('{"v":1,"a":"x","m":"INBOX","uv":"1","u":-3}').toString('base64url'),
      ),
    );
  });
});

describe('thread ids', () => {
  it('round-trips both kinds', () => {
    const gmail = {
      kind: 'gmail',
      account: 'personal',
      gmailThreadId: '1790000000000000001',
    } as const;
    const refs = {
      kind: 'references',
      account: 'work',
      mailbox: 'INBOX',
      rootMessageId: '<m1@example.com>',
    } as const;
    expect(decodeThreadId(encodeThreadId(gmail))).toEqual(gmail);
    expect(decodeThreadId(encodeThreadId(refs))).toEqual(refs);
  });

  it('does not accept a message id as a thread id', () => {
    const messageId = encodeMessageId({ account: 'a', mailbox: 'INBOX', uidValidity: '1', uid: 1 });
    expectInvalid(() => decodeThreadId(messageId));
  });
});

describe('cursors', () => {
  it('round-trips per-account offsets', () => {
    const offsets = { personal: 20, work: 3 };
    expect(decodeCursor(encodeCursor(offsets))).toEqual(offsets);
  });

  it('rejects negative offsets', () => {
    expectInvalid(() => decodeCursor(Buffer.from('{"v":1,"o":{"a":-1}}').toString('base64url')));
  });
});
