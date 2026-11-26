import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_CLIENT_ORIGINS,
  CimdError,
  type ClientMetadata,
  CimdResolver,
  redirectUriAllowed,
} from '../../src/auth/cimd.js';

const START = 1_800_000_000_000;
const MINUTE = 60_000;

const CLAUDE_CODE_ID = 'https://claude.ai/oauth/claude-code-client-metadata';
const CLAUDE_CODE_DOC = {
  client_id: CLAUDE_CODE_ID,
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};
const CLAUDE_CODE_URIS = CLAUDE_CODE_DOC.redirect_uris;

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function jsonResponse(doc: object, status = 200): Response {
  return new Response(JSON.stringify(doc), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setup(respond: () => Response | Promise<Response>): {
  resolver: CimdResolver;
  fetchFn: FetchMock;
  setNow: (at: number) => void;
} {
  let now = START;
  const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(respond()));
  return {
    resolver: new CimdResolver(fetchFn, () => now),
    fetchFn,
    setNow: (at) => {
      now = at;
    },
  };
}

async function cimdFailure(pending: Promise<ClientMetadata>): Promise<CimdError> {
  try {
    await pending;
  } catch (err) {
    if (err instanceof CimdError) return err;
    throw err;
  }
  throw new Error('expected a CimdError');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CimdResolver', () => {
  it('allows exactly claude.ai and claude.com', () => {
    expect(ALLOWED_CLIENT_ORIGINS).toEqual(['https://claude.ai', 'https://claude.com']);
  });

  it('resolves the Claude Code document with a manual-redirect JSON fetch', async () => {
    const { resolver, fetchFn } = setup(() => jsonResponse(CLAUDE_CODE_DOC));
    await expect(resolver.resolve(CLAUDE_CODE_ID)).resolves.toEqual({
      clientId: CLAUDE_CODE_ID,
      redirectUris: CLAUDE_CODE_URIS,
      clientName: 'Claude Code',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(CLAUDE_CODE_ID);
    expect(init?.redirect).toBe('manual');
    expect(init?.headers).toEqual({ accept: 'application/json' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('serves a second resolve within 10 minutes from the cache and refetches after', async () => {
    const { resolver, fetchFn, setNow } = setup(() => jsonResponse(CLAUDE_CODE_DOC));
    await resolver.resolve(CLAUDE_CODE_ID);
    setNow(START + 10 * MINUTE - 1);
    await resolver.resolve(CLAUDE_CODE_ID);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    setNow(START + 10 * MINUTE);
    await resolver.resolve(CLAUDE_CODE_ID);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure', async () => {
    let status = 404;
    const { resolver, fetchFn } = setup(() => jsonResponse(CLAUDE_CODE_DOC, status));
    await expect(resolver.resolve(CLAUDE_CODE_ID)).rejects.toBeInstanceOf(CimdError);
    status = 200;
    await expect(resolver.resolve(CLAUDE_CODE_ID)).resolves.toMatchObject({
      clientId: CLAUDE_CODE_ID,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    'https://evil.example/x',
    'http://claude.ai/x',
    'https://claude.ai.evil.example/x',
    'https://claude.ai',
    'https://claude.ai/',
    'https://claude.ai/x#frag',
    'https://user:pass@claude.ai/x',
    'https://claude.ai:443/x',
    'https://CLAUDE.ai/x',
    'not a url',
  ])('rejects %s without fetching', async (clientId) => {
    const { resolver, fetchFn } = setup(() => jsonResponse(CLAUDE_CODE_DOC));
    await expect(resolver.resolve(clientId)).rejects.toBeInstanceOf(CimdError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('accepts a claude.com client id', async () => {
    const id = 'https://claude.com/oauth/client';
    const { resolver } = setup(() => jsonResponse({ ...CLAUDE_CODE_DOC, client_id: id }));
    await expect(resolver.resolve(id)).resolves.toMatchObject({ clientId: id });
  });

  it.each([
    ['a 302 redirect', () => new Response(null, { status: 302, headers: { location: '/x' } })],
    ['a 404', () => jsonResponse(CLAUDE_CODE_DOC, 404)],
    ['a non-JSON body', () => new Response('<html></html>', { status: 200 })],
    ['an empty body', () => new Response(null, { status: 200 })],
    ['a JSON array', () => jsonResponse([CLAUDE_CODE_DOC])],
    [
      'a different client_id',
      () => jsonResponse({ ...CLAUDE_CODE_DOC, client_id: 'https://claude.ai/other' }),
    ],
    ['empty redirect_uris', () => jsonResponse({ ...CLAUDE_CODE_DOC, redirect_uris: [] })],
    [
      'client_secret_basic',
      () => jsonResponse({ ...CLAUDE_CODE_DOC, token_endpoint_auth_method: 'client_secret_basic' }),
    ],
    [
      'a missing token_endpoint_auth_method',
      () => jsonResponse({ ...CLAUDE_CODE_DOC, token_endpoint_auth_method: undefined }),
    ],
  ])('throws CimdError on %s', async (_name, respond) => {
    const { resolver } = setup(respond);
    await expect(resolver.resolve(CLAUDE_CODE_ID)).rejects.toBeInstanceOf(CimdError);
  });

  it('throws CimdError when the fetch itself fails, naming the host but not the cause', async () => {
    const { resolver } = setup(() => Promise.reject(new TypeError('secret-ish network detail')));
    const err = await cimdFailure(resolver.resolve(CLAUDE_CODE_ID));
    expect(err.message).toContain('claude.ai');
    expect(err.message).not.toContain('secret-ish');
  });

  it('does not echo the body in the error message', async () => {
    const { resolver } = setup(() => new Response('{"client_id": "BODY-MARKER"', { status: 200 }));
    const err = await cimdFailure(resolver.resolve(CLAUDE_CODE_ID));
    expect(err.message).toContain('claude.ai');
    expect(err.message).not.toContain('BODY-MARKER');
  });

  it('rejects a streamed body over 64 KiB without content-length and cancels the stream', async () => {
    let cancelled = false;
    let pulled = 0;
    const chunk = new Uint8Array(16 * 1024).fill(0x20);
    const { resolver } = setup(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    );
    await expect(resolver.resolve(CLAUDE_CODE_ID)).rejects.toBeInstanceOf(CimdError);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it('accepts a body of exactly 64 KiB', async () => {
    const json = JSON.stringify(CLAUDE_CODE_DOC);
    const padded = json + ' '.repeat(65_536 - Buffer.byteLength(json));
    const { resolver } = setup(() => new Response(padded, { status: 200 }));
    await expect(resolver.resolve(CLAUDE_CODE_ID)).resolves.toMatchObject({
      clientId: CLAUDE_CODE_ID,
    });
  });

  it('rejects a body one byte over 64 KiB', async () => {
    const json = JSON.stringify(CLAUDE_CODE_DOC);
    const padded = json + ' '.repeat(65_537 - Buffer.byteLength(json));
    const { resolver } = setup(() => new Response(padded, { status: 200 }));
    await expect(resolver.resolve(CLAUDE_CODE_ID)).rejects.toBeInstanceOf(CimdError);
  });

  it('rejects early when content-length announces more than 64 KiB', async () => {
    const { resolver } = setup(
      () =>
        new Response(JSON.stringify(CLAUDE_CODE_DOC), {
          status: 200,
          headers: { 'content-length': '65537' },
        }),
    );
    await expect(resolver.resolve(CLAUDE_CODE_ID)).rejects.toBeInstanceOf(CimdError);
  });

  it('throws CimdError when the 5 second timeout aborts the fetch', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetchFn = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
          });
        }),
    );
    const resolver = new CimdResolver(fetchFn, () => START);
    const pending = resolver.resolve(CLAUDE_CODE_ID);
    await vi.waitFor(() => {
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
    expect(timeout).toHaveBeenCalledWith(5000);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(CimdError);
  });
});

describe('redirectUriAllowed', () => {
  it.each([
    'http://127.0.0.1:53124/callback',
    'http://localhost:9/callback',
    'http://localhost/callback',
  ])('allows %s for Claude Code', (requested) => {
    expect(redirectUriAllowed(CLAUDE_CODE_URIS, requested)).toBe(true);
  });

  it.each([
    'http://127.0.0.1:53124/other',
    'https://127.0.0.1/callback',
    'http://127.0.0.2/callback',
    'http://127.0.0.1:53124/callback?x=1',
    'http://127.0.0.1:53124/callback#x',
    'http://user@127.0.0.1:53124/callback',
    'not a url',
  ])('rejects %s for Claude Code', (requested) => {
    expect(redirectUriAllowed(CLAUDE_CODE_URIS, requested)).toBe(false);
  });

  it('allows any port for an [::1] loopback registration', () => {
    expect(redirectUriAllowed(['http://[::1]/callback'], 'http://[::1]:4000/callback')).toBe(true);
  });

  it('matches a non-loopback URI exactly', () => {
    const registered = ['https://claude.ai/api/mcp/auth_callback'];
    expect(redirectUriAllowed(registered, 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(redirectUriAllowed(registered, 'https://claude.ai/api/mcp/auth_callback/')).toBe(false);
    expect(redirectUriAllowed(registered, 'https://claude.ai:8443/api/mcp/auth_callback')).toBe(
      false,
    );
  });

  it('gives an https loopback registration no port exception', () => {
    expect(redirectUriAllowed(['https://localhost/callback'], 'https://localhost:9/callback')).toBe(
      false,
    );
  });

  it('gives a loopback registration with a port no port exception', () => {
    expect(redirectUriAllowed(['http://localhost:8000/cb'], 'http://localhost:9000/cb')).toBe(
      false,
    );
  });

  it('rejects everything for an empty registration list', () => {
    expect(redirectUriAllowed([], 'http://localhost/callback')).toBe(false);
  });
});
