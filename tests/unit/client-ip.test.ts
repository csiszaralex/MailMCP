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

  it('keys an IPv6 address by its /64 prefix in one spelling', () => {
    for (const spelling of [
      '2001:DB8::1',
      '2001:db8:0:0::1',
      '2001:0db8:0000:0000:ffff:ffff:ffff:ffff',
      '2001:db8::abcd:1.2.3.4',
      '2001:db8::1%eth0',
    ]) {
      expect(clientIp(undefined, spelling, false)).toBe('2001:db8:0:0::/64');
    }
    expect(clientIp('2001:db8:1:2:3:4:5:6', undefined, true)).toBe('2001:db8:1:2::/64');
    expect(clientIp(undefined, '::1', false)).toBe('0:0:0:0::/64');
    expect(clientIp(undefined, '2001:db8:0:1::1', false)).not.toBe(
      clientIp(undefined, '2001:db8::1', false),
    );
  });

  it('leaves IPv4 and anything that is not an address as it is', () => {
    expect(clientIp(undefined, '10.0.0.1', false)).toBe('10.0.0.1');
    expect(clientIp('not-an-ip', undefined, true)).toBe('not-an-ip');
  });

  it('returns unknown when nothing is known', () => {
    expect(clientIp(undefined, undefined, false)).toBe('unknown');
    expect(clientIp(undefined, undefined, true)).toBe('unknown');
  });
});
