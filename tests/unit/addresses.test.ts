import { describe, expect, it } from 'vitest';
import type { Account } from '../../src/config/types.js';
import { addressKey, isOwnAddress, replyRecipients } from '../../src/mail/addresses.js';
import type { Address } from '../../src/mail/types.js';

function account(address: string, provider: Account['provider']): Account {
  return {
    id: 'acc',
    owner: 'alex',
    address,
    username: address,
    provider,
    level: 'send',
    signature: undefined,
    imap: { host: 'imap.example.org', port: 993 },
    smtp: { host: 'smtp.example.org', port: 465 },
    mailboxes: {},
  };
}

function addr(address: string, name = ''): Address {
  return { name, address };
}

const imapAccount = account('asd@example.org', 'imap');
const gmailAccount = account('first.last@gmail.com', 'gmail');
const bob = addr('bob@example.org', 'Bob');
const carol = addr('carol@example.org');
const dave = addr('dave@example.org');
const own = addr('asd+tag@example.org');

const addresses = (list: Address[]): string[] => list.map((a) => a.address);

describe('addressKey', () => {
  it('lowercases and drops the plus tag', () => {
    expect(addressKey('ASD+News@Example.ORG', 'imap')).toBe('asd@example.org');
  });

  it('keeps dots and domains for non-Gmail providers', () => {
    expect(addressKey('first.last@example.org', 'gmail')).toBe('first.last@example.org');
    expect(addressKey('first.last@gmail.com', 'imap')).toBe('first.last@gmail.com');
    expect(addressKey('first.last@googlemail.com', 'imap')).toBe('first.last@googlemail.com');
  });

  it('drops dots and maps googlemail.com to gmail.com for Gmail', () => {
    expect(addressKey('First.Last+x@GoogleMail.com', 'gmail')).toBe('firstlast@gmail.com');
  });

  it('compares an address without a usable local part as a whole, lowercased', () => {
    expect(addressKey('NoAtSign', 'imap')).toBe('noatsign');
    expect(addressKey('@Example.org', 'imap')).toBe('@example.org');
  });
});

describe('isOwnAddress', () => {
  it('treats plus tags and case as the same mailbox', () => {
    expect(isOwnAddress(imapAccount, 'ASD+news@Example.org')).toBe(true);
    expect(isOwnAddress(imapAccount, 'asd.x@example.org')).toBe(false);
  });

  it('ignores dots and googlemail.com only for Gmail addresses', () => {
    expect(isOwnAddress(gmailAccount, 'firstlast+x@googlemail.com')).toBe(true);
    expect(isOwnAddress(imapAccount, 'asd@googlemail.com')).toBe(false);
    expect(isOwnAddress(account('first.last@example.org', 'gmail'), 'firstlast@example.org')).toBe(
      false,
    );
  });
});

describe('replyRecipients', () => {
  it('replies to Reply-To before From', () => {
    const r = replyRecipients(
      { from: [bob], replyTo: [carol], to: [own], cc: [] },
      imapAccount,
      false,
    );
    expect(addresses(r.to)).toEqual(['carol@example.org']);
    expect(r.cc).toEqual([]);
  });

  it('replies to From when there is no Reply-To', () => {
    const r = replyRecipients(
      { from: [bob], replyTo: [], to: [own], cc: [dave] },
      imapAccount,
      false,
    );
    expect(addresses(r.to)).toEqual(['bob@example.org']);
    expect(r.cc).toEqual([]);
  });

  it('reply all adds to and cc without own addresses or duplicates', () => {
    const r = replyRecipients(
      { from: [bob], replyTo: [], to: [own, carol], cc: [bob, dave] },
      imapAccount,
      true,
    );
    expect(addresses(r.to)).toEqual(['bob@example.org']);
    expect(addresses(r.cc)).toEqual(['carol@example.org', 'dave@example.org']);
  });

  it('keeps the first occurrence of a duplicate, case and plus tag aside', () => {
    const r = replyRecipients(
      { from: [bob], replyTo: [], to: [carol, addr('CAROL+x@example.org')], cc: [] },
      imapAccount,
      true,
    );
    expect(addresses(r.cc)).toEqual(['carol@example.org']);
  });

  it('a reply to our own message goes to its recipients', () => {
    const source = { from: [own], replyTo: [bob], to: [carol, own], cc: [dave] };
    const single = replyRecipients(source, imapAccount, false);
    expect(addresses(single.to)).toEqual(['carol@example.org']);
    expect(single.cc).toEqual([]);

    const all = replyRecipients(source, imapAccount, true);
    expect(addresses(all.to)).toEqual(['carol@example.org']);
    expect(addresses(all.cc)).toEqual(['dave@example.org']);
  });

  it('drops a cc address that is already in to', () => {
    const r = replyRecipients(
      { from: [own], replyTo: [], to: [carol], cc: [addr('Carol@example.org'), dave] },
      imapAccount,
      true,
    );
    expect(addresses(r.to)).toEqual(['carol@example.org']);
    expect(addresses(r.cc)).toEqual(['dave@example.org']);
  });
});
