import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isLoopbackHost } from '../config/runtime.js';
import type { AuthEventRecord, AuthLogger } from '../log.js';
import type { Store } from '../store/store.js';
import { CimdError, type CimdResolver, redirectUriAllowed } from './cimd.js';
import type { LoginLimiter } from './limiter.js';
import type { LoginView } from './login-page.js';
import { verifyPassword, type PasswordHash } from './password.js';
import { normalizeResource, SUPPORTED_SCOPES } from './resources.js';
import {
  clientHost,
  type Clock,
  TokenGrantError,
  type TokenResponse,
  type TokenService,
} from './tokens.js';
import { matchTotp } from './totp.js';

/** D31: a pending authorization request lives 10 minutes. */
export const PENDING_REQUEST_TTL_MS = 10 * 60_000;
/** D31: an authorization code lives 60 seconds. */
export const AUTHORIZATION_CODE_TTL_MS = 60_000;

/**
 * Anyone can open pending requests with a valid Claude client_id, so their number is capped; the
 * oldest is dropped first (Map keeps insertion order). A request is at most a URL of about 16 KB,
 * so the cap bounds the memory to some 8 MB. Dropping instead of refusing means a flood cannot lock
 * the owner out: a fresh sign-in always gets in.
 */
export const MAX_PENDING_REQUESTS = 500;

const REQUEST_ID_BYTES = 16;
const CODE_BYTES = 32;
/** RFC 7636: the S256 challenge is base64url(sha256) without padding, always 43 characters. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 section 4.1: 43 to 128 unreserved characters. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

const LOGIN_FAILED = 'Invalid password or code.';
const UNKNOWN_REQUEST =
  'The sign-in request is unknown or expired. Start the sign-in again from the client.';
const MISSING_CLIENT_ID = 'The client_id parameter is missing.';
const BAD_REDIRECT_URI = 'The redirect_uri is missing or not registered for this client.';
const MISSING_PARAMS = 'code, client_id, redirect_uri and code_verifier are required.';
const INVALID_CODE = 'The authorization code is invalid, expired or already used.';

export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  resource?: string;
  scope?: string;
  state?: string;
}

export type StartResult =
  | { kind: 'login'; requestId: string; view: LoginView }
  | { kind: 'error_page'; message: string }
  /** An error redirect to a verified redirect_uri. */
  | { kind: 'redirect'; location: string };

export type CompleteResult =
  /** Success: code, state and iss. */
  | { kind: 'redirect'; location: string }
  /** Wrong credentials: the same request again with an error. */
  | { kind: 'login'; requestId: string; view: LoginView }
  /** Unknown or expired request. */
  | { kind: 'error_page'; message: string }
  | { kind: 'blocked'; retryAfterSeconds: number };

export interface RedeemParams {
  code?: string;
  client_id?: string;
  redirect_uri?: string;
  code_verifier?: string;
  resource?: string;
}

/** What a verified authorization request binds the code to (D32). */
interface Binding {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  /** The normalized resource, one of the configured resources. */
  resource: string;
  scope: string;
  state: string | undefined;
}

interface PendingRequest {
  binding: Binding;
  view: LoginView;
  expiresAt: number;
}

interface IssuedCode {
  binding: Binding;
  grantId: string;
  expiresAt: number;
  redeemed: boolean;
}

export interface AuthorizationFlowDeps {
  publicUrl: URL;
  resources: ReadonlySet<string>;
  cimd: CimdResolver;
  tokens: TokenService;
  limiter: LoginLimiter;
  store: Store;
  passwordHash: PasswordHash;
  totpSecret: Buffer;
  clock: Clock;
  log: AuthLogger;
}

/** Only the supported scopes of a space separated scope parameter, each once. */
function supportedScope(scope: string | undefined): string {
  const requested = new Set((scope ?? '').split(' '));
  return SUPPORTED_SCOPES.filter((s) => requested.has(s)).join(' ');
}

/** Appends parameters without re-encoding the redirect URI's own query (RFC 6749 3.1.2). */
function withParams(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  const added = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) added.append(name, value);
  }
  url.search = url.search === '' ? added.toString() : `${url.search.slice(1)}&${added.toString()}`;
  return url.href;
}

function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/** The authorization code flow with password and TOTP login (D31, D32, D34). */
export class AuthorizationFlow {
  private readonly deps: AuthorizationFlowDeps;
  private readonly issuer: string;
  /** Pending requests and codes live in memory only; a restart drops them. */
  private readonly pending = new Map<string, PendingRequest>();
  /** Redeemed codes stay until their expiry, so a second redemption is detected. */
  private readonly codes = new Map<string, IssuedCode>();

  constructor(deps: AuthorizationFlowDeps) {
    this.deps = deps;
    this.issuer = deps.publicUrl.origin;
  }

  /**
   * GET /authorize. client_id and redirect_uri are verified first; until both are, every error
   * is an error page and never a redirect (D31).
   */
  async start(params: AuthorizeParams): Promise<StartResult> {
    this.prune();
    const clientId = params.client_id;
    if (clientId === undefined || clientId === '') {
      this.rejected(null, 'client_id rejected');
      return { kind: 'error_page', message: MISSING_CLIENT_ID };
    }
    let registered: string[];
    try {
      registered = (await this.deps.cimd.resolve(clientId)).redirectUris;
    } catch (err) {
      if (!(err instanceof CimdError)) throw err;
      this.rejected(clientId, 'client_id rejected');
      return { kind: 'error_page', message: err.message };
    }
    const redirectUri = params.redirect_uri;
    if (
      redirectUri === undefined ||
      !URL.canParse(redirectUri) ||
      !redirectUriAllowed(registered, redirectUri)
    ) {
      this.rejected(clientId, 'redirect_uri rejected');
      return { kind: 'error_page', message: BAD_REDIRECT_URI };
    }

    const fail = (error: string, description: string, reason: string): StartResult => {
      this.rejected(clientId, reason);
      return {
        kind: 'redirect',
        location: withParams(redirectUri, {
          error,
          error_description: description,
          state: params.state,
          iss: this.issuer,
        }),
      };
    };
    if (params.response_type !== 'code') {
      return fail(
        'unsupported_response_type',
        'Only response_type=code is supported.',
        'response_type unsupported',
      );
    }
    const challenge = params.code_challenge;
    if (
      challenge === undefined ||
      !CHALLENGE_PATTERN.test(challenge) ||
      params.code_challenge_method !== 'S256'
    ) {
      return fail(
        'invalid_request',
        'A code_challenge with code_challenge_method=S256 is required.',
        'code_challenge invalid',
      );
    }
    if (params.resource === undefined) {
      return fail('invalid_target', 'The resource parameter is required.', 'resource missing');
    }
    const resource = normalizeResource(params.resource);
    if (!this.deps.resources.has(resource)) {
      return fail('invalid_target', 'The resource is not served here.', 'resource unknown');
    }

    const redirect = new URL(redirectUri);
    const view: LoginView = {
      clientHost: new URL(clientId).host,
      redirectHost: redirect.host,
      redirectOrigin: redirect.origin,
      resource,
      loopbackRedirect: isLoopbackHost(redirect.hostname),
      error: undefined,
    };
    const requestId = randomBytes(REQUEST_ID_BYTES).toString('base64url');
    while (this.pending.size >= MAX_PENDING_REQUESTS) {
      const oldest = this.pending.keys().next();
      if (oldest.done === true) break;
      this.pending.delete(oldest.value);
    }
    this.pending.set(requestId, {
      binding: {
        clientId,
        redirectUri,
        codeChallenge: challenge,
        resource,
        scope: supportedScope(params.scope),
        state: params.state,
      },
      view,
      expiresAt: this.deps.clock() + PENDING_REQUEST_TTL_MS,
    });
    return { kind: 'login', requestId, view };
  }

  /** POST /authorize: checks the limiter, then the password (always) and the TOTP code. */
  complete(input: {
    requestId: string;
    password: string;
    totp: string;
    ip: string;
  }): CompleteResult {
    this.prune();
    const request = this.pending.get(input.requestId);
    if (request === undefined) return { kind: 'error_page', message: UNKNOWN_REQUEST };
    const { binding } = request;

    const decision = this.deps.limiter.check(input.ip);
    if (!decision.allowed) {
      this.event('login_blocked', binding, input.ip, 'too many failures');
      return { kind: 'blocked', retryAfterSeconds: decision.retryAfterSeconds };
    }

    const now = this.deps.clock();
    // The hash is computed even for a malformed code, so timing does not tell which field failed.
    const passwordOk = verifyPassword(this.deps.passwordHash, input.password);
    const step = matchTotp(this.deps.totpSecret, input.totp, now);
    // A step is claimed only after a right password, so a stranger cannot burn the code.
    const ok = passwordOk && step !== undefined && this.deps.store.claimTotpStep(step, now);
    if (!ok) {
      this.deps.limiter.recordFailure(input.ip);
      this.event('login_failed', binding, input.ip, 'invalid credentials');
      return {
        kind: 'login',
        requestId: input.requestId,
        view: { ...request.view, error: LOGIN_FAILED },
      };
    }

    this.deps.limiter.recordSuccess(input.ip);
    this.pending.delete(input.requestId);
    const grantId = this.deps.tokens.createGrant({
      clientId: binding.clientId,
      resource: binding.resource,
      scope: binding.scope,
    });
    const code = randomBytes(CODE_BYTES).toString('base64url');
    this.codes.set(code, {
      binding,
      grantId,
      expiresAt: now + AUTHORIZATION_CODE_TTL_MS,
      redeemed: false,
    });
    this.event('login_ok', binding, input.ip, null);
    return {
      kind: 'redirect',
      location: withParams(binding.redirectUri, { code, state: binding.state, iss: this.issuer }),
    };
  }

  /**
   * The authorization_code grant (D32). A failed check leaves the code redeemable, so a wrong
   * guess cannot spend the legitimate client's code; a second redemption revokes the grant.
   */
  redeem(params: RedeemParams): TokenResponse {
    this.prune();
    const {
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    } = params;
    if (
      code === undefined ||
      clientId === undefined ||
      redirectUri === undefined ||
      verifier === undefined
    ) {
      throw new TokenGrantError('invalid_request', MISSING_PARAMS);
    }
    const issued = this.codes.get(code);
    if (issued === undefined) throw new TokenGrantError('invalid_grant', INVALID_CODE);
    const { binding } = issued;
    if (issued.redeemed) {
      this.deps.tokens.revokeGrant(issued.grantId);
      this.event('code_reuse', binding, null, 'code reused');
      throw new TokenGrantError('invalid_grant', INVALID_CODE);
    }
    const valid =
      clientId === binding.clientId &&
      redirectUri === binding.redirectUri &&
      VERIFIER_PATTERN.test(verifier) &&
      pkceMatches(verifier, binding.codeChallenge) &&
      (params.resource === undefined || normalizeResource(params.resource) === binding.resource);
    if (!valid) throw new TokenGrantError('invalid_grant', INVALID_CODE);

    issued.redeemed = true;
    return this.deps.tokens.issue(issued.grantId);
  }

  /** Expired entries count as unknown; they are dropped lazily on every call. */
  private prune(): void {
    const now = this.deps.clock();
    for (const [id, request] of this.pending) {
      if (request.expiresAt <= now) this.pending.delete(id);
    }
    for (const [code, issued] of this.codes) {
      if (issued.expiresAt <= now) this.codes.delete(code);
    }
  }

  private rejected(clientId: string | null, reason: string): void {
    this.deps.log({
      event: 'authorize_rejected',
      client: clientId === null ? null : clientHost(clientId),
      resource: null,
      ip: null,
      reason,
    });
  }

  private event(
    event: AuthEventRecord['event'],
    binding: Binding,
    ip: string | null,
    reason: string | null,
  ): void {
    this.deps.log({
      event,
      client: clientHost(binding.clientId),
      resource: binding.resource,
      ip,
      reason,
    });
  }
}
