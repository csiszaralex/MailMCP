import { argon2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

/** D28: the OWASP argon2id parameters, a 16 byte salt and a 32 byte output. */
const MEMORY_KIB = 19456;
const PASSES = 2;
const PARALLELISM = 1;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

export interface PasswordHash {
  memory: number;
  passes: number;
  parallelism: number;
  salt: Buffer;
  hash: Buffer;
}

const PHC_PATTERN =
  /^\$argon2id\$v=19\$m=([1-9]\d{0,9}),t=([1-9]\d{0,9}),p=([1-9]\d{0,9})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** PHC strings carry standard base64 without padding. */
function toB64(bytes: Buffer): string {
  return bytes.toString('base64').replace(/=+$/, '');
}

/** Decodes only canonical unpadded base64: Buffer.from alone silently drops stray trailing bits. */
function fromB64(text: string): Buffer | undefined {
  const bytes = Buffer.from(text, 'base64');
  return toB64(bytes) === text ? bytes : undefined;
}

function derive(password: string, params: Omit<PasswordHash, 'hash'>, length: number): Buffer {
  return argon2Sync('argon2id', {
    message: password,
    nonce: params.salt,
    memory: params.memory,
    passes: params.passes,
    parallelism: params.parallelism,
    tagLength: length,
  });
}

export function hashPassword(password: string): string {
  const params = {
    memory: MEMORY_KIB,
    passes: PASSES,
    parallelism: PARALLELISM,
    salt: randomBytes(SALT_BYTES),
  };
  const hash = derive(password, params, HASH_BYTES);
  const settings = `m=${String(MEMORY_KIB)},t=${String(PASSES)},p=${String(PARALLELISM)}`;
  return `$argon2id$v=19$${settings}$${toB64(params.salt)}$${toB64(hash)}`;
}

/** Argon2's own minimums (salt 8 bytes, output 4 bytes, memory 8 KiB per lane). */
const MIN_SALT_BYTES = 8;
const MIN_HASH_BYTES = 4;
/**
 * Upper bounds checked at start-up, so a mistyped hash cannot make the first login run out of
 * memory in the 256 MB container.
 */
const MAX_MEMORY_KIB = 65536;
const MAX_PASSES = 10;
const MAX_PARALLELISM = 16;

function withinLimits(p: PasswordHash): boolean {
  return (
    p.salt.length >= MIN_SALT_BYTES &&
    p.hash.length >= MIN_HASH_BYTES &&
    p.parallelism <= MAX_PARALLELISM &&
    p.memory >= 8 * p.parallelism &&
    p.memory <= MAX_MEMORY_KIB &&
    p.passes <= MAX_PASSES
  );
}

/** The error never quotes the input: the value is a credential. */
export function parsePasswordHash(phc: string): PasswordHash {
  const match = PHC_PATTERN.exec(phc);
  const salt = match?.[4] === undefined ? undefined : fromB64(match[4]);
  const hash = match?.[5] === undefined ? undefined : fromB64(match[5]);
  if (match === null || salt === undefined || hash === undefined) {
    throw new Error('invalid argon2id hash');
  }
  const parsed = {
    memory: Number(match[1]),
    passes: Number(match[2]),
    parallelism: Number(match[3]),
    salt,
    hash,
  };
  if (!withinLimits(parsed)) throw new Error('invalid argon2id hash');
  return parsed;
}

/** Recomputes with the stored parameters and output length, then compares in constant time. */
export function verifyPassword(hash: PasswordHash, password: string): boolean {
  const candidate = derive(password, hash, hash.hash.length);
  return timingSafeEqual(candidate, hash.hash);
}
