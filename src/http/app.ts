import { Hono } from 'hono';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import type { Account } from '../config/types.js';
import { OUTGOING_ATTACHMENTS_LIMIT_BYTES } from '../mail/compose.js';
import { buildMcpServer, type ToolDeps } from '../server.js';

/**
 * Request body limit (D14): the attachments as base64 (4/3 of their bytes) plus 2 MiB for the rest of the JSON.
 * Above the MCP SDK's default of 4 MiB, below 16 MiB.
 */
export const MAX_REQUEST_BODY_BYTES =
  Math.ceil((OUTGOING_ATTACHMENTS_LIMIT_BYTES * 4) / 3) + 2 * 1024 * 1024;

/**
 * Phase 1: localhost only, no authentication. Never expose this on a public address;
 * phase 3 replaces the localhost guards with OAuth.
 */
export function createApp(accounts: readonly Account[], deps: ToolDeps): Hono {
  const all = createMcpHandler(
    () => buildMcpServer({ accounts, scopedAccountId: undefined }, deps),
    { maxRequestBodySize: MAX_REQUEST_BODY_BYTES },
  );
  const perAccount = new Map(
    accounts.map((account) => [
      account.id,
      createMcpHandler(
        () => buildMcpServer({ accounts: [account], scopedAccountId: account.id }, deps),
        { maxRequestBodySize: MAX_REQUEST_BODY_BYTES },
      ),
    ]),
  );

  const app = new Hono();
  app.use('*', async (c, next) => {
    const rejected =
      hostHeaderValidationResponse(c.req.raw, localhostAllowedHostnames()) ??
      originValidationResponse(c.req.raw, localhostAllowedOrigins());
    if (rejected !== undefined) return rejected;
    await next();
    return undefined;
  });
  app.all('/mcp', (c) => all.fetch(c.req.raw));
  app.all('/mcp/:accountId', (c) => {
    const handler = perAccount.get(c.req.param('accountId'));
    return handler === undefined ? c.notFound() : handler.fetch(c.req.raw);
  });
  app.notFound((c) => c.text('Not found', 404));
  return app;
}
