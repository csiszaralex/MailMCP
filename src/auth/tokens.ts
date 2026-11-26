import { createHash, randomBytes } from 'node:crypto';
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { AuthEventRecord, AuthLogger } from '../log.js';
import type { GrantRow, Store, TokenKind } from '../store/store.js';

/** Milliseconds since the epoch; injected so tests can move time. */
export type Clock = () => number;

/** D32: an access token lives one hour. */
export const ACCESS_TOKEN_TTL_MS = 3_600_000;
/** D32: a refresh token lives 30 days from its issue. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3_600_000;

const TOKEN_BYTES = 32;
const GRANT_ID_BYTES = 8;
const INVALID_ACCESS_TOKEN = 'The access token is invalid or expired.';
const INVALID_REFRESH_TOKEN = 'The refresh token is invalid, expired or already used.';

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  /** Left out when the grant has no scope: RFC 6749 3.3 has no empty scope value. */
  scope?: string;
}

/** A /token failure; the message is safe to send as error_description. */
export class TokenGrantError extends Error {
  readonly code: 'invalid_grant' | 'invalid_request';

  constructor(code: 'invalid_grant' | 'invalid_request', message: string) {
    super(message);
    this.name = 'TokenGrantError';
    this.code = code;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The log names the client by the host of its client_id URL, never by the full URL. */
export function clientHost(clientId: string): string | null {
  return URL.canParse(clientId) ? new URL(clientId).host : null;
}

/** Opaque tokens bound to a grant; the store keeps only their SHA-256 hashes (D27, D32, D33). */
export class TokenService implements OAuthTokenVerifier {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly log: AuthLogger;

  constructor(store: Store, clock: Clock, log: AuthLogger) {
    this.store = store;
    this.clock = clock;
    this.log = log;
  }

  /** Creates the grant one login produces and returns its id. */
  createGrant(input: { clientId: string; resource: string; scope: string }): string {
    const id = randomBytes(GRANT_ID_BYTES).toString('hex');
    const now = this.clock();
    this.store.insertGrant({ id, ...input, createdAt: now, lastUsedAt: now });
    return id;
  }

  /** Issues a new access and refresh token pair for a live grant; ip is the client's, for the log. */
  issue(grantId: string, ip: string): TokenResponse {
    const grant = this.store.findGrant(grantId);
    // An unknown grant has no revokedAt either, so this rejects it too.
    if (grant?.revokedAt !== null) {
      throw new TokenGrantError('invalid_grant', 'The grant is unknown or revoked.');
    }
    const response = this.mint(grant);
    this.event('token_issued', grant, ip);
    return response;
  }

  /**
   * Exchanges a refresh token for a new pair (rotation). An unknown, access kind, revoked,
   * expired or other client's token is rejected without revoking anything: only a token that is
   * otherwise valid for this client proves reuse. Such a token already used (including by a
   * concurrent request that won the markTokenUsed update) revokes the whole grant.
   */
  refresh(refreshToken: string, clientId: string, ip: string): TokenResponse {
    const hash = hashToken(refreshToken);
    const row = this.store.findToken(hash);
    const now = this.clock();
    if (
      row?.kind !== 'refresh' ||
      row.grant.revokedAt !== null ||
      row.expiresAt <= now ||
      row.grant.clientId !== clientId
    ) {
      throw new TokenGrantError('invalid_grant', INVALID_REFRESH_TOKEN);
    }
    if (!this.store.markTokenUsed(hash, now)) {
      this.store.revokeGrant(row.grant.id, now);
      this.event('refresh_reuse', row.grant, ip);
      throw new TokenGrantError('invalid_grant', INVALID_REFRESH_TOKEN);
    }
    this.store.touchGrant(row.grant.id, now);
    const response = this.mint(row.grant);
    this.event('token_refreshed', row.grant, ip);
    return response;
  }

  /** False if the grant is unknown or already revoked. */
  revokeGrant(grantId: string): boolean {
    return this.store.revokeGrant(grantId, this.clock());
  }

  /** Called on every /mcp request, so it only reads: the grant is not touched here. */
  verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.store.findToken(hashToken(token));
    if (row?.kind !== 'access' || row.grant.revokedAt !== null || row.expiresAt <= this.clock()) {
      return Promise.reject(new OAuthError(OAuthErrorCode.InvalidToken, INVALID_ACCESS_TOKEN));
    }
    return Promise.resolve({
      token,
      clientId: row.grant.clientId,
      scopes: row.grant.scope.split(' ').filter(Boolean),
      expiresAt: Math.floor(row.expiresAt / 1000),
      resource: new URL(row.grant.resource),
    });
  }

  private mint(grant: GrantRow): TokenResponse {
    const now = this.clock();
    const accessToken = this.insertToken(grant.id, 'access', now + ACCESS_TOKEN_TTL_MS);
    const refreshToken = this.insertToken(grant.id, 'refresh', now + REFRESH_TOKEN_TTL_MS);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token: refreshToken,
      ...(grant.scope === '' ? {} : { scope: grant.scope }),
    };
  }

  private insertToken(grantId: string, kind: TokenKind, expiresAt: number): string {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    this.store.insertToken({ hash: hashToken(token), grantId, kind, expiresAt });
    return token;
  }

  private event(event: AuthEventRecord['event'], grant: GrantRow, ip: string): void {
    this.log({
      event,
      client: clientHost(grant.clientId),
      resource: grant.resource,
      ip,
      reason: null,
    });
  }
}
