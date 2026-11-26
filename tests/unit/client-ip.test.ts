import { describe, expect, it } from 'vitest';
import { clientIp } from '../../src/http/client-ip.js';

describe('clientIp', () => {
  it('takes the last forwarded element behind a proxy', () => {
    expect(clientIp('1.2.3.4, 5.6.7.8', '10.0.0.1', true)).toBe('5.6.7.8');
  });

  it('ignores the header when not behind a proxy', () => {
    expect(clientIp('1.2.3.4, 5.6.7.8', '10.0.0.1', false)).toBe('10.0.0.1');
  });

  it('accepts a single-element header', () => {
    expect(clientIp('1.2.3.4', '10.0.0.1', true)).toBe('1.2.3.4');
  });

  it('falls back to the connection address without a usable header', () => {
    expect(clientIp(undefined, '10.0.0.1', true)).toBe('10.0.0.1');
    expect(clientIp('', '10.0.0.1', true)).toBe('10.0.0.1');
    expect(clientIp('1.2.3.4, ', '10.0.0.1', true)).toBe('10.0.0.1');
  });

  it('maps an IPv4-mapped IPv6 address to IPv4', () => {
    expect(clientIp(undefined, '::ffff:1.2.3.4', false)).toBe('1.2.3.4');
    expect(clientIp('::ffff:5.6.7.8', undefined, true)).toBe('5.6.7.8');
  });

  it('returns unknown when nothing is known', () => {
    expect(clientIp(undefined, undefined, false)).toBe('unknown');
    expect(clientIp(undefined, undefined, true)).toBe('unknown');
  });
});
