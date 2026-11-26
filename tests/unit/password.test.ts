import { describe, expect, it } from 'vitest';
import { hashPassword, parsePasswordHash, verifyPassword } from '../../src/auth/password.js';

// The argon2id vector from the "Könyvtár tények" of the phase 3 plan (password "password", salt "somesalt").
const REFERENCE = '$argon2id$v=19$m=65536,t=2,p=4$c29tZXNhbHQ$F1jG2CV3/Nr+yRuIsPKw0J9r4s7cJHBU';
const PASSWORD = 'correct horse battery staple';
const PHC = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;

describe('verifyPassword', () => {
  it('accepts the reference vector with its own parameters', () => {
    expect(verifyPassword(parsePasswordHash(REFERENCE), 'password')).toBe(true);
  });

  it('rejects a different password', () => {
    expect(verifyPassword(parsePasswordHash(REFERENCE), 'Password')).toBe(false);
  });
});

describe('hashPassword', () => {
  it('produces the PHC string with the D28 parameters', () => {
    expect(hashPassword(PASSWORD)).toMatch(PHC);
  });

  it('verifies against its own password only', () => {
    const parsed = parsePasswordHash(hashPassword(PASSWORD));
    expect(verifyPassword(parsed, PASSWORD)).toBe(true);
    expect(verifyPassword(parsed, `${PASSWORD}!`)).toBe(false);
  });

  it('uses a fresh salt on every call', () => {
    const a = parsePasswordHash(hashPassword(PASSWORD));
    const b = parsePasswordHash(hashPassword(PASSWORD));
    expect(a.salt.equals(b.salt)).toBe(false);
  });
});

describe('parsePasswordHash', () => {
  it('reads the parameters, salt and hash', () => {
    const parsed = parsePasswordHash(REFERENCE);
    expect(parsed.memory).toBe(65536);
    expect(parsed.passes).toBe(2);
    expect(parsed.parallelism).toBe(4);
    expect(parsed.salt.toString()).toBe('somesalt');
    expect(parsed.hash.length).toBe(24);
  });

  const invalid: [string, string][] = [
    ['argon2i', '$argon2i$v=19$m=65536,t=2,p=4$c29tZXNhbHQ$F1jG2CV3/Nr+yRuIsPKw0J9r4s7cJHBU'],
    ['version 16', '$argon2id$v=16$m=65536,t=2,p=4$c29tZXNhbHQ$F1jG2CV3/Nr+yRuIsPKw0J9r4s7cJHBU'],
    ['missing hash', '$argon2id$v=19$m=65536,t=2,p=4$c29tZXNhbHQ'],
    [
      'missing parameter',
      '$argon2id$v=19$m=65536,t=2$c29tZXNhbHQ$F1jG2CV3/Nr+yRuIsPKw0J9r4s7cJHBU',
    ],
    ['bad base64', '$argon2id$v=19$m=65536,t=2,p=4$c29tZX!hbHQ$F1jG2CV3/Nr+yRuIsPKw0J9r4s7cJHBU'],
    ['base64url', '$argon2id$v=19$m=65536,t=2,p=4$c29tZXNhbHQ$F1jG2CV3_Nr-yRuIsPKw0J9r4s7cJHBU'],
    [
      'padded base64',
      '$argon2id$v=19$m=65536,t=2,p=4$c29tZXNhbHQ=$F1jG2CV3/Nr+yRuIsPKw0J9r4s7cJHBU',
    ],
    ['trailing text', `${REFERENCE}$x`],
    // 'c2FsdA' is the 4-byte salt "salt", below argon2's 8-byte minimum.
    ['short salt', '$argon2id$v=19$m=65536,t=2,p=4$c2FsdA$F1jG2CV3/Nr+yRuIsPKw0J9r4s7cJHBU'],
    [
      'memory below 8 KiB per lane',
      '$argon2id$v=19$m=16,t=2,p=4$c29tZXNhbHQ$F1jG2CV3/Nr+yRuIsPKw0J9r4s7cJHBU',
    ],
    [
      'memory above 64 MiB',
      '$argon2id$v=19$m=65537,t=2,p=4$c29tZXNhbHQ$F1jG2CV3/Nr+yRuIsPKw0J9r4s7cJHBU',
    ],
    [
      'too many passes',
      '$argon2id$v=19$m=65536,t=11,p=4$c29tZXNhbHQ$F1jG2CV3/Nr+yRuIsPKw0J9r4s7cJHBU',
    ],
    ['empty', ''],
  ];

  it.each(invalid)('rejects %s without quoting the input', (_name, input) => {
    try {
      parsePasswordHash(input);
      expect.unreachable('parsePasswordHash should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      if (err instanceof Error) {
        expect(err.message).toBe('invalid argon2id hash');
        if (input !== '') expect(err.message).not.toContain(input);
      }
    }
  });
});
