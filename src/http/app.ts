import { Hono } from 'hono';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import type { Account } from '../config/types.js';
import { buildMcpServer, type ToolDeps } from '../server.js';

/**
 * Phase 1: localhost only, no authentication. Never expose this on a public address;
 * phase 3 replaces the localhost guards with OAuth.
 */
export function createApp(accounts: readonly Account[], deps: ToolDeps): Hono {
  const all = createMcpHandler(() =>
    buildMcpServer({ accounts, scopedAccountId: undefined }, deps),
  );
  const perAccount = new Map(
    accounts.map((account) => [
      account.id,
      createMcpHandler(() =>
        buildMcpServer({ accounts: [account], scopedAccountId: account.id }, deps),
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
