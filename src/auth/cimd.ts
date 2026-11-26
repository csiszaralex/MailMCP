import * as z from 'zod';
import { parseJsonText } from '../boundary.js';
import { isLoopbackHost } from '../config/runtime.js';
import type { Clock } from './tokens.js';

/** D10: client_id metadata documents are fetched only from these origins (also rules out SSRF). */
export const ALLOWED_CLIENT_ORIGINS = ['https://claude.ai', 'https://claude.com'] as const;

/** D35: fetch limits and cache lifetime. */
export const CIMD_FETCH_TIMEOUT_MS = 5000;
export const CIMD_MAX_BYTES = 65_536;
export const CIMD_CACHE_TTL_MS = 10 * 60_000;
/** D35: a failed fetch is remembered this long, and its error is thrown again meanwhile. */
export const CIMD_FAILURE_TTL_MS = 60_000;
/**
 * D35: fetches running at the same time, over all client ids. Anyone can name any path on an
 * allowed origin, so a resolve beyond this fails at once instead of queueing.
 */
export const CIMD_MAX_CONCURRENT_FETCHES = 4;
const TOO_MANY_FETCHES = 'Too many client metadata requests, try again.';

export interface ClientMetadata {
  clientId: string;
  redirectUris: string[];
}

/** The message is safe to show on the error page: it names at most the client host, never the body. */
export class CimdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CimdError';
  }
}

/**
 * Unknown extra fields are allowed. token_endpoint_auth_method is required, because the RFC 7591
 * default when it is missing is client_secret_basic, which this server does not support.
 */
const metadataSchema = z.object({
  client_id: z.string(),
  redirect_uris: z.array(z.string()).min(1),
  token_endpoint_auth_method: z.literal('none'),
});

function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_CLIENT_ORIGINS.some((allowed) => allowed === origin);
}

/** The client_id URL if it may be fetched: canonical https URL on an allowed origin with a path. */
function allowedClientUrl(clientId: string): URL | undefined {
  if (!URL.canParse(clientId)) return undefined;
  const url = new URL(clientId);
  const ok =
    url.href === clientId &&
    url.protocol === 'https:' &&
    isAllowedOrigin(url.origin) &&
    url.pathname !== '' &&
    url.pathname !== '/' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === '';
  return ok ? url : undefined;
}

async function readLimitedText(response: Response, host: string): Promise<string> {
  const tooLarge = (): CimdError =>
    new CimdError(`Client metadata from ${host} is larger than ${String(CIMD_MAX_BYTES)} bytes.`);
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (declared > CIMD_MAX_BYTES) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    // The reader's chunks are typed `any` here; a fetch Response streams Uint8Array chunks.
    if (!(chunk.value instanceof Uint8Array))
      throw new TypeError('response body chunk is not bytes');
    const value = chunk.value;
    total += value.byteLength;
    if (total > CIMD_MAX_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

export class CimdResolver {
  private readonly fetchFn: typeof fetch;
  private readonly clock: Clock;
  private readonly cache = new Map<string, { metadata: ClientMetadata; expiresAt: number }>();
  private readonly failures = new Map<string, { error: CimdError; expiresAt: number }>();
  /** One fetch per client id: concurrent resolves of the same id share it. */
  private readonly inFlight = new Map<string, Promise<ClientMetadata>>();

  constructor(fetchFn: typeof fetch, clock: Clock) {
    this.fetchFn = fetchFn;
    this.clock = clock;
  }

  /** Fetches and validates the client's metadata document (D35); throws CimdError. */
  async resolve(clientId: string): Promise<ClientMetadata> {
    const url = allowedClientUrl(clientId);
    if (url === undefined) {
      throw new CimdError('client_id is not an allowed client metadata URL.');
    }
    const now = this.clock();
    const cached = this.cache.get(clientId);
    if (cached !== undefined && now < cached.expiresAt) return cached.metadata;
    const failed = this.failures.get(clientId);
    if (failed !== undefined && now < failed.expiresAt) throw failed.error;
    const running = this.inFlight.get(clientId);
    if (running !== undefined) return running;
    if (this.inFlight.size >= CIMD_MAX_CONCURRENT_FETCHES) throw new CimdError(TOO_MANY_FETCHES);

    this.dropExpired(now);
    const fetching = this.fetchAndRemember(clientId, url.host);
    this.inFlight.set(clientId, fetching);
    return fetching;
  }

  /** Caches the document or the CimdError; the in-flight entry goes when it settles. */
  private async fetchAndRemember(clientId: string, host: string): Promise<ClientMetadata> {
    try {
      const metadata = await this.fetchMetadata(clientId, host);
      this.cache.set(clientId, { metadata, expiresAt: this.clock() + CIMD_CACHE_TTL_MS });
      return metadata;
    } catch (err) {
      if (err instanceof CimdError) {
        this.failures.set(clientId, { error: err, expiresAt: this.clock() + CIMD_FAILURE_TTL_MS });
      }
      throw err;
    } finally {
      this.inFlight.delete(clientId);
    }
  }

  /** Expired entries count as missing; they are dropped before every new fetch. */
  private dropExpired(now: number): void {
    for (const [id, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(id);
    }
    for (const [id, entry] of this.failures) {
      if (entry.expiresAt <= now) this.failures.delete(id);
    }
  }

  private async fetchMetadata(clientId: string, host: string): Promise<ClientMetadata> {
    let text;
    try {
      const response = await this.fetchFn(clientId, {
        redirect: 'manual',
        signal: AbortSignal.timeout(CIMD_FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new CimdError(
          `Client metadata from ${host} answered HTTP ${String(response.status)}.`,
        );
      }
      text = await readLimitedText(response, host);
    } catch (err) {
      if (err instanceof CimdError) throw err;
      throw new CimdError(`Client metadata from ${host} could not be fetched.`);
    }

    const invalid = new CimdError(`Client metadata from ${host} is not a valid document.`);
    let raw;
    try {
      raw = parseJsonText(text);
    } catch {
      throw invalid;
    }
    const parsed = metadataSchema.safeParse(raw);
    if (!parsed.success || parsed.data.client_id !== clientId) throw invalid;
    return { clientId, redirectUris: parsed.data.redirect_uris };
  }
}

/** A registered http loopback URI without a port: the client picks the port at runtime. */
function portlessLoopback(uri: string): URL | undefined {
  if (!URL.canParse(uri)) return undefined;
  const url = new URL(uri);
  const loopback = url.protocol === 'http:' && isLoopbackHost(url.hostname) && url.port === '';
  return loopback ? url : undefined;
}

/**
 * Exact string match, except that a registered portless http loopback URI accepts any port as long
 * as everything else (scheme, host, path, query, no fragment or credentials) is the same.
 */
export function redirectUriAllowed(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  if (!URL.canParse(requested)) return false;
  const req = new URL(requested);
  return registered.some((uri) => {
    const reg = portlessLoopback(uri);
    if (reg === undefined) return false;
    return (
      req.protocol === reg.protocol &&
      req.hostname === reg.hostname &&
      req.pathname === reg.pathname &&
      req.search === reg.search &&
      req.hash === reg.hash &&
      req.username === reg.username &&
      req.password === reg.password
    );
  });
}
