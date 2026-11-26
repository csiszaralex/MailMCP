import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { buildOAuthProtectedResourceMetadata } from '@modelcontextprotocol/server';
import type {
  AuthorizationFlow,
  AuthorizeParams,
  CompleteResult,
  RedeemParams,
  StartResult,
} from '../auth/flow.js';
import {
  loginPageHeaders,
  PAGE_HEADERS,
  renderErrorPage,
  renderLoginPage,
} from '../auth/login-page.js';
import { authorizationServerMetadata, SUPPORTED_SCOPES } from '../auth/resources.js';
import { TokenGrantError, type TokenService } from '../auth/tokens.js';
import { clientIp } from './client-ip.js';

export interface OAuthRouteDeps {
  publicUrl: URL;
  /** MCP endpoint path ('/mcp', '/mcp/<id>') to its resource identifier, from resourceUrls. */
  resources: Map<string, string>;
  flow: AuthorizationFlow;
  tokens: TokenService;
  behindProxy: boolean;
  /** The connection's peer address; injected so tests need no real Node server. */
  remoteAddress: (c: Context) => string | undefined;
}

/** Both form endpoints take a few short fields; 16 KiB is far above any honest request. */
const MAX_FORM_BYTES = 16 * 1024;
const FORM_TYPE = 'application/x-www-form-urlencoded';
const PROTECTED_RESOURCE_PREFIX = '/.well-known/oauth-protected-resource';
const METADATA_HEADERS: Readonly<Record<string, string>> = { 'Access-Control-Allow-Origin': '*' };
/** RFC 6749 5.1: token responses must not be cached. */
const TOKEN_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
};

const AUTHORIZE_KEYS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'resource',
  'scope',
  'state',
] as const satisfies readonly (keyof AuthorizeParams)[];
const REDEEM_KEYS = [
  'code',
  'client_id',
  'redirect_uri',
  'code_verifier',
  'resource',
] as const satisfies readonly (keyof RedeemParams)[];

const TOO_LARGE = 'The request is too large.';
const NOT_A_FORM = 'The sign-in form must be sent as application/x-www-form-urlencoded.';
const FOREIGN_ORIGIN = "The sign-in form must be sent from this server's own page.";
const BLOCKED = 'Too many failed sign-ins. Try again later.';

type Fields = Readonly<Record<string, string>>;

/** Only the given keys, and only those present: exactOptionalPropertyTypes forbids undefined. */
function pick<K extends string>(fields: Fields, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = fields[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The first value of every query parameter. */
function queryFields(c: Context): Fields {
  const out: Record<string, string> = {};
  for (const [name, value] of new URL(c.req.url).searchParams) {
    out[name] ??= value;
  }
  return out;
}

/** The string fields of a form body; a file field counts as missing. */
async function formFields(c: Context): Promise<Fields> {
  const body = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(body)) {
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

function isForm(c: Context): boolean {
  return (c.req.header('content-type') ?? '').toLowerCase().startsWith(FORM_TYPE);
}

function html(body: string, status: number, headers: Readonly<Record<string, string>>): Response {
  return new Response(body, { status, headers });
}

function errorPage(message: string, status: number, extra: Fields = {}): Response {
  return html(renderErrorPage(message), status, { ...PAGE_HEADERS, ...extra });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function pageFor(result: StartResult | CompleteResult): Response {
  switch (result.kind) {
    case 'login':
      return html(
        renderLoginPage(result.requestId, result.view),
        200,
        loginPageHeaders(result.view),
      );
    case 'error_page':
      return errorPage(result.message, 400);
    case 'redirect':
      return redirect(result.location);
    case 'blocked':
      return errorPage(BLOCKED, 429, { 'Retry-After': String(result.retryAfterSeconds) });
  }
}

function tokenJson(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...TOKEN_HEADERS, 'Content-Type': 'application/json' },
  });
}

function tokenError(error: string, description: string, status = 400): Response {
  return tokenJson({ error, error_description: description }, status);
}

function methodNotAllowed(allow: string): Response {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: allow } });
}

/** The OAuth metadata, authorize and token endpoints (D31, D32, D34). */
export function registerOAuthRoutes(app: Hono, deps: OAuthRouteDeps): void {
  const asMetadata = authorizationServerMetadata(deps.publicUrl);
  const asBody = JSON.stringify(asMetadata);
  const prBodies = new Map(
    [...deps.resources].map(([path, resource]) => [
      path,
      JSON.stringify(
        buildOAuthProtectedResourceMetadata({
          oauthMetadata: asMetadata,
          resourceServerUrl: new URL(resource),
          scopesSupported: [...SUPPORTED_SCOPES],
          resourceName: 'MailMCP',
        }),
      ),
    ]),
  );
  const metadata = (body: string | undefined): Response =>
    body === undefined
      ? new Response('Not found', { status: 404 })
      : new Response(body, {
          headers: { ...METADATA_HEADERS, 'Content-Type': 'application/json' },
        });

  // Hono answers HEAD with the GET handler, so the catch-all after it sees every other method.
  app.get('/.well-known/oauth-authorization-server', () => metadata(asBody));
  app.all('/.well-known/oauth-authorization-server', () => methodNotAllowed('GET, HEAD'));
  app.get(`${PROTECTED_RESOURCE_PREFIX}/mcp`, () => metadata(prBodies.get('/mcp')));
  app.all(`${PROTECTED_RESOURCE_PREFIX}/mcp`, () => methodNotAllowed('GET, HEAD'));
  app.get(`${PROTECTED_RESOURCE_PREFIX}/mcp/:accountId`, (c) =>
    metadata(prBodies.get(`/mcp/${c.req.param('accountId')}`)),
  );
  app.all(`${PROTECTED_RESOURCE_PREFIX}/mcp/:accountId`, () => methodNotAllowed('GET, HEAD'));

  const ipOf = (c: Context): string =>
    clientIp(c.req.header('x-forwarded-for'), deps.remoteAddress(c), deps.behindProxy);

  app.get('/authorize', async (c) => {
    const params: AuthorizeParams = pick(queryFields(c), AUTHORIZE_KEYS);
    return pageFor(await deps.flow.start(params, ipOf(c)));
  });

  app.post(
    '/authorize',
    bodyLimit({ maxSize: MAX_FORM_BYTES, onError: () => errorPage(TOO_LARGE, 413) }),
    async (c) => {
      // The sealed request (only this server can make one) and this check together stand in for
      // a CSRF token (D31).
      if (c.req.header('origin') !== deps.publicUrl.origin) return errorPage(FOREIGN_ORIGIN, 403);
      if (!isForm(c)) return errorPage(NOT_A_FORM, 400);
      const form = await formFields(c);
      return pageFor(
        deps.flow.complete({
          requestId: form.request ?? '',
          password: form.password ?? '',
          totp: form.totp ?? '',
          ip: ipOf(c),
        }),
      );
    },
  );
  app.all('/authorize', () => methodNotAllowed('GET, HEAD, POST'));

  app.post(
    '/token',
    bodyLimit({
      maxSize: MAX_FORM_BYTES,
      onError: () => tokenError('invalid_request', 'The request body is too large.', 413),
    }),
    async (c) => {
      if (!isForm(c)) {
        return tokenError('invalid_request', `The body must be ${FORM_TYPE}.`);
      }
      const form = await formFields(c);
      const ip = ipOf(c);
      try {
        if (form.grant_type === 'authorization_code') {
          return tokenJson(deps.flow.redeem(pick(form, REDEEM_KEYS), ip), 200);
        }
        if (form.grant_type === 'refresh_token') {
          const { refresh_token: refreshToken, client_id: clientId } = form;
          if (refreshToken === undefined || clientId === undefined) {
            return tokenError('invalid_request', 'refresh_token and client_id are required.');
          }
          return tokenJson(deps.tokens.refresh(refreshToken, clientId, ip), 200);
        }
        return tokenError(
          'unsupported_grant_type',
          'Only authorization_code and refresh_token are supported.',
        );
      } catch (err) {
        if (err instanceof TokenGrantError) return tokenError(err.code, err.message);
        throw err;
      }
    },
  );
  app.all('/token', () => methodNotAllowed('POST'));
}
