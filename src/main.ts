import { readFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { loadConfig, parsePort } from './config/load.js';
import { MailError } from './errors.js';
import { createApp } from './http/app.js';
import { tlsConnector } from './imap/client.js';
import { ImapPool } from './imap/pool.js';
import { errorClass, stderrLogger } from './log.js';
import { ImapMailProvider } from './mail/imap-provider.js';
import { ImapMailWriter } from './mail/imap-writer.js';
import type { ToolDeps } from './server.js';
import { tlsSmtpSender } from './smtp/sender.js';

const HOSTNAME = '127.0.0.1';
/** How long shutdown waits for open requests and IMAP logouts before it exits anyway. */
const SHUTDOWN_GRACE_MS = 5_000;

const accountsFile = process.env.MAILMCP_ACCOUNTS_FILE ?? 'accounts.yaml';

let config;
let port;
try {
  port = parsePort(process.env.MAILMCP_PORT);
  config = loadConfig(await readFile(accountsFile, 'utf8'), process.env);
} catch (err) {
  const message = err instanceof Error ? err.message : 'unknown error';
  process.stderr.write(`mailmcp: cannot start: ${message}\n`);
  process.exit(1);
}

const pool = new ImapPool(tlsConnector(config.passwordFor));
const providers = new Map(config.accounts.map((a) => [a.id, new ImapMailProvider(a, pool)]));
const smtp = tlsSmtpSender(config.passwordFor, false);
const writers = new Map(
  [...providers].map(([id, p]) => [id, new ImapMailWriter(p.account, pool, p, smtp)]),
);
function lookup<T>(map: Map<string, T>, id: string): T {
  const found = map.get(id);
  if (found === undefined) throw new MailError('unknown_account', `Unknown account "${id}".`);
  return found;
}
const deps: ToolDeps = {
  providerFor: (id) => lookup(providers, id),
  writerFor: (id) => lookup(writers, id),
  log: stderrLogger,
};

const accountCount = config.accounts.length;
const server = serve(
  { fetch: createApp(config.accounts, deps).fetch, hostname: HOSTNAME, port },
  () => {
    process.stderr.write(
      `mailmcp: listening on http://${HOSTNAME}:${String(port)}/mcp (${String(accountCount)} accounts)\n`,
    );
  },
);
server.on('error', (err: Error) => {
  const { code, name } = errorClass(err);
  process.stderr.write(`mailmcp: cannot listen on ${HOSTNAME}:${String(port)}: ${code ?? name}\n`);
  process.exit(1);
});

let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
  const httpClosed = new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  void Promise.all([httpClosed, pool.closeAll()]).then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
