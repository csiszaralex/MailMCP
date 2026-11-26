import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** D29: RFC 6238 with HMAC-SHA1, 30 second steps, 6 digits and one step of drift. */
const PERIOD_SECONDS = 30;
const DIGITS = 6;
const DRIFT_STEPS = 1;
const SECRET_BYTES = 20;
const ISSUER = 'MailMCP';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding. */
export function base32Encode(bytes: Buffer): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET.charAt((buffer >> bits) & 31);
    }
  }
  if (bits > 0) out += ALPHABET.charAt((buffer << (5 - bits)) & 31);
  return out;
}

/** Accepts either case and ignores spaces and `=` padding; any other character throws. */
export function base32Decode(text: string): Buffer {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text.toUpperCase().replace(/[ =]/g, '')) {
    const value = ALPHABET.indexOf(char);
    if (value === -1) throw new Error('invalid base32 character');
    buffer = ((buffer << 5) | value) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export function newTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** The HOTP value (RFC 4226 dynamic truncation) of one time step. */
export function totpAt(secret: Buffer, step: number, digits: number = DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * The matched step within one step of now, or undefined. Only exactly six ASCII digits are
 * accepted, and every candidate step is compared in constant time.
 */
export function matchTotp(secret: Buffer, code: string, nowMs: number): number | undefined {
  if (!/^[0-9]{6}$/.test(code)) return undefined;
  const given = Buffer.from(code);
  const current = Math.floor(nowMs / 1000 / PERIOD_SECONDS);
  let matched: number | undefined;
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step += 1) {
    if (step < 0) continue;
    const equal = timingSafeEqual(Buffer.from(totpAt(secret, step)), given);
    if (equal && matched === undefined) matched = step;
  }
  return matched;
}

export function otpauthUri(secret: Buffer, account: string): string {
  const label = `${ISSUER}:${encodeURIComponent(account)}`;
  const params = `secret=${base32Encode(secret)}&issuer=${ISSUER}&algorithm=SHA1&digits=${String(DIGITS)}&period=${String(PERIOD_SECONDS)}`;
  return `otpauth://totp/${label}?${params}`;
}
