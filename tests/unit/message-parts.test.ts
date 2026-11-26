import { describe, expect, it } from 'vitest';
import type { FetchMessageObject, MessageStructureObject } from 'imapflow';
import {
  collectAttachments,
  messageDate,
  receivedDate,
  replyToAddresses,
  textParts,
  threadRootId,
  toAddresses,
} from '../../src/mail/message-parts.js';

describe('toAddresses', () => {
  it('keeps entries with an address and defaults the name', () => {
    expect(
      toAddresses([
        { name: 'Bob', address: 'bob@example.org' },
        { address: 'c@example.org' },
        { name: 'nobody' },
      ]),
    ).toEqual([
      { name: 'Bob', address: 'bob@example.org' },
      { name: '', address: 'c@example.org' },
    ]);
    expect(toAddresses(undefined)).toEqual([]);
  });
});

describe('replyToAddresses', () => {
  const bob = { name: 'Bob', address: 'bob@example.org' };
  const desk = { name: 'Desk', address: 'desk@example.org' };

  it('is empty when it names exactly the From addresses', () => {
    expect(replyToAddresses({ from: [bob], replyTo: [bob] })).toEqual([]);
    expect(
      replyToAddresses({ from: [bob], replyTo: [{ name: 'B', address: ' BOB@example.ORG' }] }),
    ).toEqual([]);
    expect(replyToAddresses({ from: [bob] })).toEqual([]);
  });

  it('keeps a distinct Reply-To', () => {
    expect(replyToAddresses({ from: [bob], replyTo: [desk] })).toEqual([desk]);
    expect(replyToAddresses({ from: [bob], replyTo: [bob, desk] })).toEqual([bob, desk]);
    expect(replyToAddresses({ replyTo: [desk] })).toEqual([desk]);
  });

  it('keeps a Reply-To that names only some of several From addresses', () => {
    expect(replyToAddresses({ from: [bob, desk], replyTo: [bob] })).toEqual([bob]);
    expect(replyToAddresses({ from: [bob, desk], replyTo: [desk, bob] })).toEqual([]);
  });

  it('keeps a Reply-To that differs from From only by a +tag', () => {
    const tagged = { name: 'Bob', address: 'bob+lists@example.org' };
    expect(replyToAddresses({ from: [bob], replyTo: [tagged] })).toEqual([tagged]);
  });
});

describe('messageDate', () => {
  it('prefers the envelope date and falls back to the internal date', () => {
    const base = { seq: 1, uid: 1 };
    expect(messageDate({ ...base, envelope: { date: new Date('2026-11-10T08:00:00Z') } })).toBe(
      '2026-11-10T08:00:00.000Z',
    );
    expect(messageDate({ ...base, internalDate: '2026-11-11T09:00:00Z' })).toBe(
      '2026-11-11T09:00:00.000Z',
    );
    expect(messageDate(base as FetchMessageObject)).toBeNull();
  });
});

describe('receivedDate', () => {
  it('uses only the server internal date', () => {
    const base = { seq: 1, uid: 1, envelope: { date: new Date('2030-01-01T00:00:00Z') } };
    expect(receivedDate({ ...base, internalDate: new Date('2026-11-11T09:00:00Z') })).toBe(
      '2026-11-11T09:00:00.000Z',
    );
    expect(receivedDate(base)).toBeNull();
  });
});

describe('collectAttachments', () => {
  it('finds attachment leaves in a multipart tree', () => {
    const tree: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 20 },
        {
          part: '2',
          type: 'application/pdf',
          disposition: 'attachment',
          dispositionParameters: { filename: 'invoice.pdf' },
          size: 1200,
        },
        { part: '3', type: 'image/png', parameters: { name: 'logo.png' }, size: 300 },
        { part: '4', type: 'text/html', disposition: 'inline', size: 50 },
      ],
    };
    expect(collectAttachments(tree)).toEqual([
      { attachmentId: '2', filename: 'invoice.pdf', mimeType: 'application/pdf', size: 1200 },
      { attachmentId: '3', filename: 'logo.png', mimeType: 'image/png', size: 300 },
    ]);
    expect(collectAttachments(undefined)).toEqual([]);
  });
});

describe('collectAttachments with an attached message', () => {
  it('lists the attached message itself, not its inner parts', () => {
    const tree: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 20 },
        {
          part: '2',
          type: 'message/rfc822',
          disposition: 'attachment',
          dispositionParameters: { filename: 'forwarded.eml' },
          size: 5000,
          childNodes: [
            {
              part: '2',
              type: 'multipart/mixed',
              childNodes: [
                { part: '2.1', type: 'text/plain', size: 30 },
                {
                  part: '2.2',
                  type: 'application/pdf',
                  disposition: 'attachment',
                  dispositionParameters: { filename: 'inner.pdf' },
                  size: 900,
                },
              ],
            },
          ],
        },
        {
          part: '3',
          type: 'message/rfc822',
          size: 700,
          childNodes: [{ part: '3.1', type: 'text/plain' }],
        },
      ],
    };
    expect(collectAttachments(tree)).toEqual([
      { attachmentId: '2', filename: 'forwarded.eml', mimeType: 'message/rfc822', size: 5000 },
      { attachmentId: '3', filename: 'message.eml', mimeType: 'message/rfc822', size: 700 },
    ]);
  });
});

describe('threadRootId', () => {
  it('uses the first References entry', () => {
    const headers = Buffer.from('References: <root@example.org>\r\n <mid@example.org>\r\n\r\n');
    expect(threadRootId(headers, '<own@example.org>')).toBe('<root@example.org>');
  });

  it('falls back to the own Message-ID', () => {
    expect(threadRootId(Buffer.from('\r\n'), '<own@example.org>')).toBe('<own@example.org>');
    expect(threadRootId(undefined, undefined)).toBeUndefined();
  });
});

describe('textParts', () => {
  const alternative: MessageStructureObject = {
    type: 'multipart/mixed',
    childNodes: [
      {
        part: '1',
        type: 'multipart/alternative',
        childNodes: [
          { part: '1.1', type: 'text/plain' },
          { part: '1.2', type: 'text/html' },
        ],
      },
      { part: '2', type: 'text/plain', disposition: 'attachment' },
      {
        part: '3',
        type: 'message/rfc822',
        childNodes: [{ part: '3.1', type: 'text/plain' }],
      },
    ],
  };

  it('picks the inline parts of the requested type', () => {
    expect(textParts(alternative, 'plain')).toEqual([{ part: '1.1', type: 'text/plain' }]);
    expect(textParts(alternative, 'html')).toEqual([{ part: '1.2', type: 'text/html' }]);
  });

  it('falls back to the other text type', () => {
    const htmlOnly: MessageStructureObject = { type: 'text/html' };
    expect(textParts(htmlOnly, 'plain')).toEqual([{ part: '1', type: 'text/html' }]);
    expect(textParts(undefined, 'plain')).toEqual([]);
  });
});
