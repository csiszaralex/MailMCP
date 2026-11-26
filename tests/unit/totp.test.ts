import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  matchTotp,
  newTotpSecret,
  otpauthUri,
  totpAt,
} from '../../src/auth/totp.js';

// RFC 6238 appendix B, SHA1: the ASCII key and the 8 digit codes per Unix time T.
const KEY = Buffer.from('12345678901234567890');
const VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('totpAt', () => {
  it.each(VECTORS)('matches the RFC 6238 vector at T=%i', (t, code) => {
    expect(totpAt(KEY, Math.floor(t / 30), 8)).toBe(code);
  });

  it('gives the last six digits by default', () => {
    expect(totpAt(KEY, Math.floor(59 / 30))).toBe('287082');
  });
});

describe('matchTotp', () => {
  const step = Math.floor(59 / 30);
  const code = '287082';

  it('returns the matching step at the same time', () => {
    expect(matchTotp(KEY, code, 59_000)).toBe(step);
  });

  it('accepts one step of drift in either direction', () => {
    expect(matchTotp(KEY, code, 59_000 - 30_000)).toBe(step);
    expect(matchTotp(KEY, code, 59_000 + 30_000)).toBe(step);
  });

  it('rejects two steps of drift', () => {
    expect(matchTotp(KEY, code, 59_000 - 60_000)).toBeUndefined();
    expect(matchTotp(KEY, code, 59_000 + 60_000)).toBeUndefined();
  });

  it.each(['28708', '2870820', '28708a', ' 287082', '２８７０８２', ''])(
    'rejects the malformed code %j',
    (bad) => {
      expect(matchTotp(KEY, bad, 59_000)).toBeUndefined();
    },
  );

  it('rejects a wrong code', () => {
    expect(matchTotp(KEY, '287083', 59_000)).toBeUndefined();
  });
});

describe('base32', () => {
  it('encodes the RFC 6238 key', () => {
    expect(base32Encode(KEY)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('round-trips a 20 byte secret', () => {
    const secret = newTotpSecret();
    expect(secret.length).toBe(20);
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
  });

  it('decodes lower case, spaces and padding', () => {
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').equals(KEY)).toBe(true);
    expect(base32Decode('MZXW6===').toString()).toBe('foo');
  });

  it.each(['GEZD1', 'GEZD8', 'GE-ZD', 'GEZD\n'])('rejects the character in %j', (bad) => {
    expect(() => base32Decode(bad)).toThrow(Error);
  });

  it('gives a different secret on every call', () => {
    expect(newTotpSecret().equals(newTotpSecret())).toBe(false);
  });
});

describe('otpauthUri', () => {
  it('builds the authenticator URI with an encoded label', () => {
    expect(otpauthUri(KEY, 'alex@example.com')).toBe(
      'otpauth://totp/MailMCP:alex%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=MailMCP&algorithm=SHA1&digits=6&period=30',
    );
  });
});
