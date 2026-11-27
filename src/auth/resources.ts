import type { OAuthMetadata } from '@modelcontextprotocol/server';

/** offline_access makes Claude ask for a refresh token; no other scope exists. */
export const SUPPORTED_SCOPES = ['offline_access'] as const;

export const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';
export const PROTECTED_RESOURCE_METADATA_PREFIX = '/.well-known/oauth-protected-resource';

/** The MCP endpoint that reaches every account. */
export const MCP_PATH = '/mcp';

/** The MCP endpoint of one account. */
export function accountMcpPath(accountId: string): string {
  return `${MCP_PATH}/${accountId}`;
}

/** The OAuth endpoints, as the metadata names them and the routes serve them. */
export const AUTHORIZE_PATH = '/authorize';
export const TOKEN_PATH = '/token';

/**
 * Every MCP endpoint path and its resource identifier (D33). The identifier is built from the
 * configured public origin, never from a request URL.
 */
export function resourceUrls(publicUrl: URL, accountIds: readonly string[]): Map<string, string> {
  const paths = [MCP_PATH, ...accountIds.map(accountMcpPath)];
  return new Map(paths.map((path) => [path, `${publicUrl.origin}${path}`]));
}

/** RFC 8414 metadata of the built-in authorization server. */
export function authorizationServerMetadata(publicUrl: URL): OAuthMetadata {
  const origin = publicUrl.origin;
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${TOKEN_PATH}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SUPPORTED_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** Drops a fragment and then one trailing slash, so `<origin>/mcp/` names `<origin>/mcp`. */
export function normalizeResource(value: string): string {
  const hash = value.indexOf('#');
  const withoutFragment = hash === -1 ? value : value.slice(0, hash);
  return withoutFragment.endsWith('/') ? withoutFragment.slice(0, -1) : withoutFragment;
}
