import { Hono } from 'hono';
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  originValidationResponse,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import { resourceUrls } from '../auth/resources.js';
import type { Account } from '../config/types.js';
import { OUTGOING_ATTACHMENTS_LIMIT_BYTES } from '../mail/compose.js';
import { buildMcpServer, type ToolDeps } from '../server.js';
import {
  AUTHORIZATION_SERVER_METADATA_PATH,
  PROTECTED_RESOURCE_METADATA_PREFIX,
  registerOAuthRoutes,
  type OAuthRouteDeps,
} from './oauth-routes.js';

/**
 * Request body limit (D14): the attachments as base64 (4/3 of their bytes) plus 2 MiB for the rest of the JSON.
 * Above the MCP SDK's default of 4 MiB, below 16 MiB.
 */
export const MAX_REQUEST_BODY_BYTES =
  Math.ceil((OUTGOING_ATTACHMENTS_LIMIT_BYTES * 4) / 3) + 2 * 1024 * 1024;

export interface AppOptions {
  /** MAILMCP_PUBLIC_URL: the only accepted Host and Origin, and the base of every resource. */
  publicUrl: URL;
  oauth: Omit<OAuthRouteDeps, 'publicUrl' | 'resources'>;
}

type McpHandler = ReturnType<typeof createMcpHandler>;

/** 403 in the SDK's validation response shape when a present Origin is not exactly ours. */
function foreignOrigin(origin: string | undefined, allowed: string): Response | undefined {
  if (origin === undefined || origin === '' || origin === allowed) return undefined;
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32000, message: 'Invalid Origin' }, id: null },
    { status: 403 },
  );
}

/**
 * GET and HEAD of the OAuth metadata documents skip the Origin check on purpose: they are public,
 * carry Access-Control-Allow-Origin: *, and a client's backend or a browser-based client may send
 * its own Origin. The Host check still applies to them.
 */
function isPublicMetadata(method: string, path: string): boolean {
  return (
    (method === 'GET' || method === 'HEAD') &&
    (path === AUTHORIZATION_SERVER_METADATA_PATH ||
      path.startsWith(`${PROTECTED_RESOURCE_METADATA_PREFIX}/`))
  );
}

/**
 * The MCP endpoints and the OAuth routes (D30, D33). Every request's Host must carry the public
 * URL's hostname (DNS rebinding) and an Origin, when present, must be the public origin, or the
 * answer is 403; only the metadata documents accept any Origin (isPublicMetadata). Each MCP endpoint
 * accepts only a Bearer token issued for its own resource identifier, so a token for /mcp/a is
 * refused on /mcp and /mcp/b. A 401 points to that endpoint's protected resource metadata.
 */
export function createApp(accounts: readonly Account[], deps: ToolDeps, options: AppOptions): Hono {
  const { publicUrl } = options;
  const resources = resourceUrls(
    publicUrl,
    accounts.map((a) => a.id),
  );
  const handlers = new Map<string, McpHandler>([
    [
      '/mcp',
      createMcpHandler(() => buildMcpServer({ accounts, scopedAccountId: undefined }, deps), {
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      }),
    ],
    ...accounts.map((account): [string, McpHandler] => [
      `/mcp/${account.id}`,
      createMcpHandler(
        () => buildMcpServer({ accounts: [account], scopedAccountId: account.id }, deps),
        { maxRequestBodySize: MAX_REQUEST_BODY_BYTES },
      ),
    ]),
  ]);
  const endpoints = new Map(
    [...resources].map(([path, resourceId]) => {
      const handler = handlers.get(path);
      if (handler === undefined) throw new Error(`No MCP handler for ${path}.`);
      const resource = new URL(resourceId);
      const gate = requireBearerAuth({
        verifier: options.oauth.tokens,
        expectedResource: resource,
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
      });
      const serve = async (request: Request): Promise<Response> => {
        const auth = await gate(request);
        if (auth instanceof Response) return auth;
        return handler.fetch(request, { authInfo: auth });
      };
      return [path, serve];
    }),
  );

  // Both SDK checks compare URL hostnames, which keep the brackets of an IPv6 literal ('[::1]'),
  // so publicUrl.hostname matches the parsed Host and Origin as is. They ignore the port, and the
  // Origin check the scheme too, so foreignOrigin adds the exact origin match D30 asks for.
  const allowedHostnames = [publicUrl.hostname];
  const app = new Hono();
  app.use('*', async (c, next) => {
    const rejected =
      hostHeaderValidationResponse(c.req.raw, allowedHostnames) ??
      (isPublicMetadata(c.req.method, c.req.path)
        ? undefined
        : (originValidationResponse(c.req.raw, allowedHostnames) ??
          foreignOrigin(c.req.header('origin'), publicUrl.origin)));
    if (rejected !== undefined) return rejected;
    await next();
    return undefined;
  });
  registerOAuthRoutes(app, { publicUrl, resources, ...options.oauth });
  app.all('/mcp', (c) => endpoints.get('/mcp')?.(c.req.raw) ?? c.notFound());
  // An unknown account answers 404 before the token is looked at.
  app.all('/mcp/:accountId', (c) => {
    const serve = endpoints.get(`/mcp/${c.req.param('accountId')}`);
    return serve === undefined ? c.notFound() : serve(c.req.raw);
  });
  app.notFound((c) => c.text('Not found', 404));
  return app;
}
