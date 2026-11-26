import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { hashPassword } from './auth/password.js';
import { clientHost } from './auth/tokens.js';
import { base32Encode, newTotpSecret, otpauthUri } from './auth/totp.js';
import { DEFAULT_DATA_DIR, Store, storePath } from './store/store.js';

/** D36: the operator commands. Everything the commands touch comes through this object. */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readSecret: (prompt: string) => Promise<string>;
  /** True when the secret prompt is interactive: hash-password then asks twice. */
  isTty: boolean;
  env: Readonly<Record<string, string | undefined>>;
  now: () => number;
}

const MIN_PASSWORD_LENGTH = 12;
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_INTERRUPTED = 130;

const USAGE = `Usage: pnpm cli <command>

Commands:
  hash-password          Read a password and print its argon2id hash
  totp-setup [account]   Print a new TOTP secret and its otpauth:// URI (default account: admin)
  tokens list            List the OAuth grants
  tokens revoke <id>     Revoke a grant
  help                   Show this text
`;

/** Thrown by the real readSecret on Ctrl+C; runCli turns it into exit code 130. */
class SecretAborted extends Error {
  constructor() {
    super('aborted');
    this.name = 'SecretAborted';
  }
}

async function hashPasswordCommand(io: CliIo): Promise<number> {
  const password = await io.readSecret('Password: ');
  if (io.isTty) {
    const repeat = await io.readSecret('Repeat: ');
    if (repeat !== password) {
      io.stderr('The two passwords do not match.\n');
      return EXIT_FAILURE;
    }
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    io.stderr(`The password must be at least ${String(MIN_PASSWORD_LENGTH)} characters long.\n`);
    return EXIT_FAILURE;
  }
  io.stdout(`${hashPassword(password)}\n`);
  io.stderr('Put this into MAILMCP_ADMIN_PASSWORD_HASH (in docker compose write every $ as $$).\n');
  return EXIT_OK;
}

function totpSetupCommand(account: string, io: CliIo): number {
  const secret = newTotpSecret();
  io.stdout(`${base32Encode(secret)}\n${otpauthUri(secret, account)}\n`);
  io.stderr(
    'Put the first line into MAILMCP_TOTP_SECRET and add the second to your authenticator app.\n',
  );
  return EXIT_OK;
}

/**
 * Runs a command on the server's database. A missing file means a wrong MAILMCP_DATA_DIR far more
 * often than a fresh install, so it fails instead of creating an empty database there.
 */
function withStore(io: CliIo, run: (store: Store) => number): number {
  const configured = io.env.MAILMCP_DATA_DIR;
  const dataDir = configured === undefined || configured === '' ? DEFAULT_DATA_DIR : configured;
  const path = storePath(dataDir);
  if (!existsSync(path)) {
    io.stderr(`No database at ${path}. Is MAILMCP_DATA_DIR right?\n`);
    return EXIT_FAILURE;
  }
  const store = Store.open(path);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function tokensList(io: CliIo): number {
  return withStore(io, (store) => {
    const grants = store.listGrants();
    if (grants.length === 0) {
      io.stdout('No grants.\n');
      return EXIT_OK;
    }
    for (const grant of grants) {
      io.stdout(
        `${[
          grant.id,
          clientHost(grant.clientId) ?? '-',
          grant.resource,
          iso(grant.createdAt),
          iso(grant.lastUsedAt),
          grant.revokedAt === null ? 'active' : 'revoked',
        ].join('  ')}\n`,
      );
    }
    return EXIT_OK;
  });
}

function tokensRevoke(id: string, io: CliIo): number {
  return withStore(io, (store) => {
    if (!store.revokeGrant(id, io.now())) {
      io.stderr(`No active grant with id ${id}.\n`);
      return EXIT_FAILURE;
    }
    io.stdout(`Revoked ${id}.\n`);
    return EXIT_OK;
  });
}

function usageError(io: CliIo): number {
  io.stderr(USAGE);
  return EXIT_USAGE;
}

async function dispatch(args: readonly string[], io: CliIo): Promise<number> {
  const [command, first, second] = args;
  switch (command) {
    case 'help':
    case '--help':
      io.stdout(USAGE);
      return EXIT_OK;
    case 'hash-password':
      return hashPasswordCommand(io);
    case 'totp-setup':
      return totpSetupCommand(first ?? 'admin', io);
    case 'tokens':
      if (first === 'list') return tokensList(io);
      if (first === 'revoke' && second !== undefined && second !== '') {
        return tokensRevoke(second, io);
      }
      return usageError(io);
    case undefined:
    default:
      return usageError(io);
  }
}

export async function runCli(args: readonly string[], io: CliIo): Promise<number> {
  try {
    return await dispatch(args, io);
  } catch (err) {
    if (err instanceof SecretAborted) return EXIT_INTERRUPTED;
    io.stderr(`mailmcp: ${err instanceof Error ? err.message : 'unexpected error'}\n`);
    return EXIT_FAILURE;
  }
}

/** Raw mode without echo: Enter ends, Backspace deletes, Ctrl+C rejects with SecretAborted. */
function readFromTty(prompt: string): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (settle: () => void): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      settle();
    };
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          finish(() => {
            resolve(value);
          });
          return;
        }
        if (char === '\u0003') {
          finish(() => {
            reject(new SecretAborted());
          });
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = Array.from(value).slice(0, -1).join('');
        } else if (char >= ' ') {
          value += char;
        }
      }
    };
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/** Not a TTY: the whole of stdin, minus one trailing \r\n or \n. */
async function readFromPipe(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

function realIo(): CliIo {
  const isTty = process.stdin.isTTY;
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readSecret: isTty ? readFromTty : readFromPipe,
    isTty,
    env: process.env,
    now: () => Date.now(),
  };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await runCli(process.argv.slice(2), realIo());
}
