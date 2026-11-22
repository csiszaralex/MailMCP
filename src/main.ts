import { readFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { loadConfig } from './config/load.js';
import { MailError } from './errors.js';
import { createApp } from './http/app.js';
import { connectTls } from './imap/client.js';
import { ImapPool } from './imap/pool.js';
import { stderrLogger } from './log.js';
import { ImapMailProvider } from './mail/imap-provider.js';
import type { ToolDeps } from './server.js';

const accountsFile = process.env.MAILMCP_ACCOUNTS_FILE ?? 'accounts.yaml';
const port = Number(process.env.MAILMCP_PORT ?? '8787');

let config;
try {
  config = loadConfig(await readFile(accountsFile, 'utf8'), process.env);
} catch (err) {
  const message = err instanceof Error ? err.message : 'unknown error';
  process.stderr.write(`mailmcp: cannot start: ${message}\n`);
  process.exit(1);
}

const pool = new ImapPool(connectTls);
const providers = new Map(config.accounts.map((a) => [a.id, new ImapMailProvider(a, pool)]));
const deps: ToolDeps = {
  providerFor: (id) => {
    const provider = providers.get(id);
    if (provider === undefined) throw new MailError('unknown_account', `Unknown account "${id}".`);
    return provider;
  },
  log: stderrLogger,
};

const server = serve({
  fetch: createApp(config.accounts, deps).fetch,
  hostname: '127.0.0.1',
  port,
});
process.stderr.write(
  `mailmcp: listening on http://127.0.0.1:${String(port)}/mcp (${String(config.accounts.length)} accounts)\n`,
);

const shutdown = (): void => {
  server.close();
  void pool.closeAll();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
