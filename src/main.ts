import { readFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { CimdResolver } from './auth/cimd.js';
import { AuthorizationFlow } from './auth/flow.js';
import { LoginLimiter } from './auth/limiter.js';
import { resourceUrls } from './auth/resources.js';
import { TokenService } from './auth/tokens.js';
import { loadConfig } from './config/load.js';
import { loadRuntime } from './config/runtime.js';
import { MailError } from './errors.js';
import { createApp } from './http/app.js';
import { tlsConnector } from './imap/client.js';
import { ImapPool } from './imap/pool.js';
import { errorClass, stderrAuthLogger, stderrHttpErrorLogger, stderrLogger } from './log.js';
import { ImapMailProvider } from './mail/imap-provider.js';
import { ImapMailWriter } from './mail/imap-writer.js';
import type { ToolDeps } from './server.js';
import { tlsSmtpSender } from './smtp/sender.js';
import { Store, storePath } from './store/store.js';

/** How long shutdown waits for open requests and IMAP logouts before it exits anyway. */
const SHUTDOWN_GRACE_MS = 5_000;
/** Expired tokens are deleted once an hour, a day after their expiry. */
const PRUNE_INTERVAL_MS = 3_600_000;
const PRUNE_AFTER_MS = 86_400_000;

const accountsFile = process.env.MAILMCP_ACCOUNTS_FILE ?? 'accounts.yaml';

let runtime;
let config;
let store;
try {
  // Also enforces D30: the public URL and both auth secrets are required, and MAILMCP_DEBUG
  // (which prints mail content, D25) only starts with loopback addresses.
  runtime = loadRuntime(process.env);
  config = loadConfig(await readFile(accountsFile, 'utf8'), process.env);
  store = Store.open(storePath(runtime.dataDir));
} catch (err) {
  const message = err instanceof Error ? err.message : 'unknown error';
  process.stderr.write(`mailmcp: cannot start: ${message}\n`);
  process.exit(1);
}

const { host, port, debug } = runtime;
const pool = new ImapPool(tlsConnector(config.passwordFor, debug));
const providers = new Map(config.accounts.map((a) => [a.id, new ImapMailProvider(a, pool)]));
const smtp = tlsSmtpSender(config.passwordFor, debug);
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

const tokens = new TokenService(store, Date.now, stderrAuthLogger);
// One map for both: the flow accepts exactly the resources the app serves.
const resources = resourceUrls(
  runtime.publicUrl,
  config.accounts.map((a) => a.id),
);
const flow = new AuthorizationFlow({
  publicUrl: runtime.publicUrl,
  resources: new Set(resources.values()),
  cimd: new CimdResolver(fetch, Date.now),
  tokens,
  limiter: new LoginLimiter(store, Date.now),
  store,
  passwordHash: runtime.passwordHash,
  totpSecret: runtime.totpSecret,
  clock: Date.now,
  log: stderrAuthLogger,
});
const app = createApp(config.accounts, deps, {
  publicUrl: runtime.publicUrl,
  resources,
  oauth: {
    flow,
    tokens,
    behindProxy: runtime.behindProxy,
    remoteAddress: (c) => getConnInfo(c).remote.address,
  },
  logError: stderrHttpErrorLogger,
});

const pruneTimer = setInterval(() => {
  store.pruneTokens(Date.now() - PRUNE_AFTER_MS);
}, PRUNE_INTERVAL_MS);
pruneTimer.unref();

const accountCount = config.accounts.length;
const publicOrigin = runtime.publicUrl.origin;
const server = serve({ fetch: app.fetch, hostname: host, port }, () => {
  process.stderr.write(
    `mailmcp: listening on ${host}:${String(port)}, public URL ${publicOrigin} (${String(accountCount)} accounts)${debug ? ' (protocol debug log on: mail content is printed)' : ''}\n`,
  );
});
server.on('error', (err: Error) => {
  const { code, name } = errorClass(err);
  process.stderr.write(`mailmcp: cannot listen on ${host}:${String(port)}: ${code ?? name}\n`);
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
  clearInterval(pruneTimer);
  void Promise.all([httpClosed, pool.closeAll()]).then(() => {
    store.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
