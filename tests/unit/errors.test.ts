import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';

describe('MailError', () => {
  it('carries a machine-readable code and a message', () => {
    const error = new MailError('stale_id', 'Message id is stale, search again.');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MailError');
    expect(error.code).toBe('stale_id');
    expect(error.message).toBe('Message id is stale, search again.');
  });

  it('keeps the cause', () => {
    const cause = new Error('socket closed');
    const error = new MailError('connection_failed', 'IMAP connection failed', { cause });
    expect(error.cause).toBe(cause);
  });
});
