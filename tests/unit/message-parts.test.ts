import { describe, expect, it } from 'vitest';
import type { FetchMessageObject, MessageStructureObject } from 'imapflow';
import {
  collectAttachments,
  messageDate,
  receivedDate,
  textParts,
  threadRootId,
  toAddresses,
} from '../../src/mail/message-parts.js';

describe('toAddresses', () => {
  it('keeps entries with an address and defaults the name', () => {
    expect(
      toAddresses([
        { name: 'Bob', address: 'bob@x.org' },
        { address: 'c@x.org' },
        { name: 'nobody' },
      ]),
    ).toEqual([
      { name: 'Bob', address: 'bob@x.org' },
      { name: '', address: 'c@x.org' },
    ]);
    expect(toAddresses(undefined)).toEqual([]);
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

describe('threadRootId', () => {
  it('uses the first References entry', () => {
    const headers = Buffer.from('References: <root@x.org>\r\n <mid@x.org>\r\n\r\n');
    expect(threadRootId(headers, '<own@x.org>')).toBe('<root@x.org>');
  });

  it('falls back to the own Message-ID', () => {
    expect(threadRootId(Buffer.from('\r\n'), '<own@x.org>')).toBe('<own@x.org>');
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
