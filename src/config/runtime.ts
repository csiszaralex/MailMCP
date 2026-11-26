import { base32Decode } from '../auth/totp.js';
import { parsePasswordHash, type PasswordHash } from '../auth/password.js';
import { MailError } from '../errors.js';
import { parseDebug, parsePort } from './load.js';

type Env = Readonly<Record<string, string | undefined>>;

const MIN_TOTP_SECRET_BYTES = 10;

export interface RuntimeConfig {
  /** Origin only, e.g. http://127.0.0.1:8787 */
  publicUrl: URL;
  host: string;
  port: number;
  dataDir: string;
  behindProxy: boolean;
  debug: boolean;
  passwordHash: PasswordHash;
  totpSecret: Buffer;
}

/** `new URL('http://[::1]:8787').hostname` keeps the brackets, so both spellings count. */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

function invalid(message: string): MailError {
  return new MailError('config_invalid', message);
}

/** An unset or empty variable counts as missing. */
function read(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function required(env: Env, name: string): string {
  const value = read(env, name);
  if (value === undefined) throw invalid(`${name} is required.`);
  return value;
}

/** The errors never quote the value: a URL with credentials would print a password. */
function parsePublicUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalid('MAILMCP_PUBLIC_URL must be an absolute URL.');
  }
  const allowedScheme = isLoopbackHost(url.hostname) ? ['http:', 'https:'] : ['https:'];
  if (!allowedScheme.includes(url.protocol)) {
    throw invalid('MAILMCP_PUBLIC_URL must use https (http is allowed only for a loopback host).');
  }
  if (
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw invalid(
      'MAILMCP_PUBLIC_URL must be an origin only: no path, query, fragment or credentials.',
    );
  }
  return new URL(url.origin);
}

function parseBehindProxy(value: string | undefined): boolean {
  if (value === undefined || value === '0') return false;
  if (value === '1') return true;
  throw invalid(`MAILMCP_BEHIND_PROXY must be 0 or 1, got "${value}".`);
}

/** The errors name the variable only: both values are credentials. */
function parseHash(value: string): PasswordHash {
  try {
    return parsePasswordHash(value);
  } catch {
    throw invalid('MAILMCP_ADMIN_PASSWORD_HASH is not a valid argon2id PHC hash.');
  }
}

function parseTotpSecret(value: string): Buffer {
  let secret: Buffer;
  try {
    secret = base32Decode(value);
  } catch {
    throw invalid('MAILMCP_TOTP_SECRET is not valid base32.');
  }
  if (secret.length < MIN_TOTP_SECRET_BYTES) {
    throw invalid(
      `MAILMCP_TOTP_SECRET must decode to at least ${String(MIN_TOTP_SECRET_BYTES)} bytes.`,
    );
  }
  return secret;
}

export function loadRuntime(env: Env): RuntimeConfig {
  const publicUrl = parsePublicUrl(required(env, 'MAILMCP_PUBLIC_URL'));
  const host = read(env, 'MAILMCP_HOST') ?? '127.0.0.1';
  const port = parsePort(read(env, 'MAILMCP_PORT'));
  const dataDir = read(env, 'MAILMCP_DATA_DIR') ?? './data';
  const behindProxy = parseBehindProxy(read(env, 'MAILMCP_BEHIND_PROXY'));
  const debug = parseDebug(read(env, 'MAILMCP_DEBUG'));
  const passwordHash = parseHash(required(env, 'MAILMCP_ADMIN_PASSWORD_HASH'));
  const totpSecret = parseTotpSecret(required(env, 'MAILMCP_TOTP_SECRET'));

  if (debug && !(isLoopbackHost(publicUrl.hostname) && isLoopbackHost(host))) {
    throw invalid(
      'MAILMCP_DEBUG=1 needs a loopback MAILMCP_PUBLIC_URL host and a loopback MAILMCP_HOST: per D25 the protocol debug log only runs locally.',
    );
  }

  return { publicUrl, host, port, dataDir, behindProxy, debug, passwordHash, totpSecret };
}
