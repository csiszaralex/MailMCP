import { describe, expect, it } from 'vitest';
import {
  ARCHIVE,
  flagChange,
  folderDestination,
  gmailLabelChange,
} from '../../src/mail/label-plan.js';

describe('flagChange', () => {
  it('turns STARRED into \\Flagged and UNREAD into the absence of \\Seen', () => {
    expect(flagChange({ add: ['STARRED', 'Work'], remove: ['UNREAD'] })).toEqual({
      add: ['\\Flagged', '\\Seen'],
      remove: [],
    });
    expect(flagChange({ add: ['UNREAD'], remove: ['STARRED', 'INBOX'] })).toEqual({
      add: [],
      remove: ['\\Flagged', '\\Seen'],
    });
  });
});

describe('gmailLabelChange', () => {
  it('maps INBOX and IMPORTANT, keeps other names and leaves out the flag labels', () => {
    expect(
      gmailLabelChange({ add: ['Work', 'IMPORTANT', 'STARRED'], remove: ['INBOX', 'UNREAD'] }),
    ).toEqual({ add: ['Work', '\\Important'], remove: ['\\Inbox'] });
  });

  it('refuses TRASH and SPAM', () => {
    expect(() => gmailLabelChange({ add: ['TRASH'], remove: [] })).toThrow(
      expect.objectContaining({ code: 'unsupported_query' }),
    );
    expect(() => gmailLabelChange({ add: [], remove: ['SPAM'] })).toThrow(
      expect.objectContaining({
        message: 'Use trash or mark_spam to move messages to the trash or spam.',
      }),
    );
  });
});

describe('folderDestination', () => {
  const expectRefused = (plan: () => void): void => {
    expect(plan).toThrow(expect.objectContaining({ code: 'unsupported_query' }));
  };

  it('moves to one added folder and ignores the flag labels', () => {
    expect(folderDestination({ add: ['STARRED', 'Work'], remove: ['UNREAD'] }, 'INBOX')).toBe(
      'Work',
    );
    expect(folderDestination({ add: ['STARRED'], remove: [] }, 'INBOX')).toBeUndefined();
  });

  it('archives when INBOX is removed from INBOX', () => {
    expect(folderDestination({ add: [], remove: ['INBOX'] }, 'INBOX')).toBe(ARCHIVE);
  });

  it('refuses every other combination', () => {
    expectRefused(() => folderDestination({ add: ['A', 'B'], remove: [] }, 'INBOX'));
    expectRefused(() => folderDestination({ add: [], remove: ['Work'] }, 'Work'));
    expectRefused(() => folderDestination({ add: ['Work'], remove: ['INBOX'] }, 'INBOX'));
    expectRefused(() => folderDestination({ add: [], remove: ['INBOX'] }, 'Work'));
  });
});
