import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePasswordHash, verifyPassword } from '../../src/auth/password.js';
import { runCli, type CliIo } from '../../src/cli.js';
import { Store, storePath } from '../../src/store/store.js';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const GOOD_PASSWORD = 'correct horse battery staple';

interface Harness {
  io: CliIo;
  out: () => string;
  err: () => string;
  prompts: string[];
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailmcp-cli-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function harness(answers: string[], isTty = true): Harness {
  let out = '';
  let err = '';
  const prompts: string[] = [];
  const queue = [...answers];
  const io: CliIo = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    readSecret: (prompt) => {
      prompts.push(prompt);
      const next = queue.shift();
      return next === undefined
        ? Promise.reject(new Error('no scripted answer left'))
        : Promise.resolve(next);
    },
    isTty,
    env: { MAILMCP_DATA_DIR: dir },
    now: () => NOW,
    healthTimeoutMs: 200,
  };
  return { io, out: () => out, err: () => err, prompts };
}

/** Creates the database the server would have created, with no grant in it. */
function seedEmpty(): void {
  Store.open(storePath(dir)).close();
}

function seedGrant(id: string, revokedAt: number | null = null): void {
  const store = Store.open(storePath(dir));
  try {
    store.insertGrant({
      id,
      clientId: 'https://claude.ai/oauth/client.json',
      resource: 'http://127.0.0.1:8787/mcp/work',
      scope: 'mail',
      createdAt: Date.UTC(2026, 10, 25, 8, 0, 0),
      lastUsedAt: Date.UTC(2026, 10, 26, 9, 30, 0),
    });
    if (revokedAt !== null) store.revokeGrant(id, revokedAt);
  } finally {
    store.close();
  }
}

describe('hash-password', () => {
  it('prints only a verifiable hash on stdout and asks twice on a TTY', async () => {
    const h = harness([GOOD_PASSWORD, GOOD_PASSWORD]);
    expect(await runCli(['hash-password'], h.io)).toBe(0);
    expect(h.prompts).toEqual(['Password: ', 'Repeat: ']);
    expect(h.out()).toMatch(/^\$argon2id\$[^\n]+\n$/);
    expect(verifyPassword(parsePasswordHash(h.out().trimEnd()), GOOD_PASSWORD)).toBe(true);
    expect(h.err()).toBe(
      'Put this into MAILMCP_ADMIN_PASSWORD_HASH (in docker compose write every $ as $$).\n',
    );
    expect(h.err()).not.toContain(GOOD_PASSWORD);
  });

  it('reads once when stdin is not a TTY', async () => {
    const h = harness([GOOD_PASSWORD], false);
    expect(await runCli(['hash-password'], h.io)).toBe(0);
    expect(h.prompts).toEqual(['Password: ']);
    expect(h.out()).toMatch(/^\$argon2id\$/);
  });

  it('fails with 1 when the repeat differs', async () => {
    const h = harness([GOOD_PASSWORD, `${GOOD_PASSWORD}!`]);
    expect(await runCli(['hash-password'], h.io)).toBe(1);
    expect(h.out()).toBe('');
    expect(h.err()).toContain('do not match');
  });

  it('fails with 1 when the password is shorter than 12 characters', async () => {
    const h = harness(['short', 'short']);
    expect(await runCli(['hash-password'], h.io)).toBe(1);
    expect(h.out()).toBe('');
    expect(h.err()).toContain('at least 12 characters');
    expect(h.err()).not.toContain('short\n');
  });
});

describe('totp-setup', () => {
  it('prints a 32 character base32 secret and an otpauth URI containing it', async () => {
    const h = harness([]);
    expect(await runCli(['totp-setup'], h.io)).toBe(0);
    const lines = h.out().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    const secret = lines[0] ?? '';
    const uri = lines[1] ?? '';
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(uri).toMatch(/^otpauth:\/\/totp\/MailMCP:admin\?/);
    expect(uri).toContain(`secret=${secret}`);
    expect(h.err()).toBe(
      'Put the first line into MAILMCP_TOTP_SECRET and add the second to your authenticator app.\n',
    );
  });

  it('uses the given account name', async () => {
    const h = harness([]);
    expect(await runCli(['totp-setup', 'alex'], h.io)).toBe(0);
    expect(h.out()).toContain('otpauth://totp/MailMCP:alex?');
  });
});

describe('tokens list', () => {
  it('prints No grants. for an empty store', async () => {
    seedEmpty();
    const h = harness([]);
    expect(await runCli(['tokens', 'list'], h.io)).toBe(0);
    expect(h.out()).toBe('No grants.\n');
  });

  it('prints one line per grant with host, resource, ISO times and state', async () => {
    seedGrant('grant-active');
    seedGrant('grant-revoked', NOW);
    const h = harness([]);
    expect(await runCli(['tokens', 'list'], h.io)).toBe(0);
    const lines = h.out().trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const fields = (lines.find((l) => l.startsWith('grant-active')) ?? '').split('  ');
    expect(fields).toEqual([
      'grant-active',
      'claude.ai',
      'http://127.0.0.1:8787/mcp/work',
      '2026-11-25T08:00:00.000Z',
      '2026-11-26T09:30:00.000Z',
      'active',
    ]);
    expect(lines.find((l) => l.startsWith('grant-revoked'))?.endsWith('  revoked')).toBe(true);
  });
});

describe('tokens without a database', () => {
  it('fails with 1 and names the path instead of creating an empty database', async () => {
    const missing = join(dir, 'nested');
    for (const args of [
      ['tokens', 'list'],
      ['tokens', 'revoke', 'grant-1'],
    ]) {
      const h = harness([]);
      h.io.env = { MAILMCP_DATA_DIR: missing };
      expect(await runCli(args, h.io)).toBe(1);
      expect(h.out()).toBe('');
      expect(h.err()).toBe(
        `No database at ${storePath(missing)}. Is MAILMCP_DATA_DIR right?
`,
      );
    }
    expect(existsSync(missing)).toBe(false);
  });
});

describe('tokens revoke', () => {
  it('revokes once with 0, then reports the repeat with 1', async () => {
    seedGrant('grant-1');
    const first = harness([]);
    expect(await runCli(['tokens', 'revoke', 'grant-1'], first.io)).toBe(0);
    expect(first.out()).toBe('Revoked grant-1.\n');
    const second = harness([]);
    expect(await runCli(['tokens', 'revoke', 'grant-1'], second.io)).toBe(1);
    expect(second.out()).toBe('');
    expect(second.err()).toContain('grant-1');
  });

  it('returns 1 for an unknown id', async () => {
    seedEmpty();
    const h = harness([]);
    expect(await runCli(['tokens', 'revoke', 'nope'], h.io)).toBe(1);
    expect(h.err()).toContain('nope');
  });

  it('returns 2 without an id', async () => {
    const h = harness([]);
    expect(await runCli(['tokens', 'revoke'], h.io)).toBe(2);
    expect(h.err()).toContain('Usage');
  });
});

describe('usage', () => {
  it('returns 2 with usage on stderr for an unknown command', async () => {
    const h = harness([]);
    expect(await runCli(['nope'], h.io)).toBe(2);
    expect(h.err()).toContain('Usage');
    expect(h.out()).toBe('');
  });

  it('returns 2 for no command and for an unknown tokens subcommand', async () => {
    expect(await runCli([], harness([]).io)).toBe(2);
    expect(await runCli(['tokens'], harness([]).io)).toBe(2);
    expect(await runCli(['tokens', 'purge'], harness([]).io)).toBe(2);
  });

  it('prints usage on stdout with 0 for help and --help', async () => {
    for (const flag of ['help', '--help']) {
      const h = harness([]);
      expect(await runCli([flag], h.io)).toBe(0);
      expect(h.out()).toContain('Usage');
      expect(h.err()).toBe('');
    }
  });

  it('returns 1 with the message when reading the secret fails', async () => {
    const h = harness([]);
    expect(await runCli(['hash-password'], h.io)).toBe(1);
    expect(h.err()).toContain('no scripted answer left');
  });
});

describe('health', () => {
  interface Seen {
    path: string | undefined;
    headers: IncomingHttpHeaders;
  }

  let server: Server | undefined;

  async function closeServer(): Promise<void> {
    const running = server;
    server = undefined;
    if (running === undefined) return;
    await new Promise<void>((resolve) => {
      running.close(() => {
        resolve();
      });
    });
  }

  afterEach(closeServer);

  /** A server on a free loopback port; status null never answers. */
  async function serve(status: number | null, seen: Seen[] = []): Promise<number> {
    const created = createServer((req, res) => {
      seen.push({ path: req.url, headers: req.headers });
      if (status === null) return;
      res.writeHead(status).end('{}');
    });
    server = created;
    await new Promise<void>((resolve) => {
      created.listen(0, '127.0.0.1', resolve);
    });
    return (created.address() as AddressInfo).port;
  }

  function healthIo(port: number): Harness {
    const h = harness([]);
    h.io.env = {
      MAILMCP_PUBLIC_URL: 'https://mail.example',
      MAILMCP_HOST: '0.0.0.0',
      MAILMCP_PORT: String(port),
    };
    return h;
  }

  it('returns 0 silently when the metadata answers 200 for the public host', async () => {
    const seen: Seen[] = [];
    const h = healthIo(await serve(200, seen));
    expect(await runCli(['health'], h.io)).toBe(0);
    expect(h.out()).toBe('');
    expect(h.err()).toBe('');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('/.well-known/oauth-authorization-server');
    expect(seen[0]?.headers.host).toBe('mail.example');
  });

  it('returns 1 with the status for any other answer', async () => {
    const h = healthIo(await serve(503));
    expect(await runCli(['health'], h.io)).toBe(1);
    expect(h.err()).toBe('health: HTTP 503\n');
  });

  it('returns 1 with the error code when nothing listens', async () => {
    const port = await serve(200);
    await closeServer();
    const h = healthIo(port);
    expect(await runCli(['health'], h.io)).toBe(1);
    expect(h.err()).toBe('health: ECONNREFUSED\n');
  });

  it('returns 1 when the server does not answer in time', async () => {
    const h = healthIo(await serve(null));
    expect(await runCli(['health'], h.io)).toBe(1);
    expect(h.err()).toBe('health: timeout\n');
  });

  it('returns 1 with the configuration error', async () => {
    const h = harness([]);
    h.io.env = {};
    expect(await runCli(['health'], h.io)).toBe(1);
    expect(h.err()).toBe('mailmcp: MAILMCP_PUBLIC_URL is required.\n');
  });
});
