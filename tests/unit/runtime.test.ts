import { describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import { isLoopbackHost, loadHealthTarget, loadRuntime } from '../../src/config/runtime.js';
import { MailError } from '../../src/errors.js';

const HASH = hashPassword('correct horse battery staple');
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const BASE = {
  MAILMCP_PUBLIC_URL: 'http://127.0.0.1:8787',
  MAILMCP_ADMIN_PASSWORD_HASH: HASH,
  MAILMCP_TOTP_SECRET: SECRET,
};

function failure(env: Record<string, string | undefined>): MailError {
  try {
    loadRuntime(env);
  } catch (err) {
    if (err instanceof MailError) return err;
    throw err;
  }
  throw new Error('loadRuntime did not throw');
}

describe('loadRuntime', () => {
  it('applies the defaults', () => {
    const config = loadRuntime(BASE);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8787);
    expect(config.dataDir).toBe('./data');
    expect(config.behindProxy).toBe(false);
    expect(config.debug).toBe(false);
    expect(config.publicUrl.origin).toBe('http://127.0.0.1:8787');
    expect(config.totpSecret.length).toBe(20);
    expect(config.passwordHash.salt.length).toBeGreaterThan(0);
  });

  it('reads the optional variables', () => {
    const config = loadRuntime({
      ...BASE,
      MAILMCP_HOST: '0.0.0.0',
      MAILMCP_PORT: '9000',
      MAILMCP_DATA_DIR: '/var/lib/mailmcp',
      MAILMCP_BEHIND_PROXY: '1',
    });
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(9000);
    expect(config.dataDir).toBe('/var/lib/mailmcp');
    expect(config.behindProxy).toBe(true);
  });

  it('rejects a missing or empty public url and names the variable', () => {
    const rest = { ...BASE, MAILMCP_PUBLIC_URL: undefined };
    expect(failure(rest).code).toBe('config_invalid');
    expect(failure(rest).message).toContain('MAILMCP_PUBLIC_URL');
    expect(failure({ ...BASE, MAILMCP_PUBLIC_URL: '' }).message).toContain('MAILMCP_PUBLIC_URL');
  });

  it('allows http only on loopback', () => {
    expect(failure({ ...BASE, MAILMCP_PUBLIC_URL: 'http://mail.example.com' }).message).toContain(
      'MAILMCP_PUBLIC_URL',
    );
    expect(
      loadRuntime({ ...BASE, MAILMCP_PUBLIC_URL: 'https://mail.example.com' }).publicUrl.href,
    ).toBe('https://mail.example.com/');
    expect(
      loadRuntime({ ...BASE, MAILMCP_PUBLIC_URL: 'http://localhost:8787' }).publicUrl.origin,
    ).toBe('http://localhost:8787');
    // The SDK refuses an http issuer on [::1], so the start-up must refuse it first.
    expect(failure({ ...BASE, MAILMCP_PUBLIC_URL: 'http://[::1]:8787' }).message).toContain(
      'MAILMCP_PUBLIC_URL',
    );
    expect(
      loadRuntime({ ...BASE, MAILMCP_PUBLIC_URL: 'https://[::1]:8787' }).publicUrl.origin,
    ).toBe('https://[::1]:8787');
  });

  it('rejects other schemes and unparsable urls', () => {
    for (const url of ['ftp://x.example', 'not a url', 'x.example']) {
      expect(failure({ ...BASE, MAILMCP_PUBLIC_URL: url }).message).toContain('MAILMCP_PUBLIC_URL');
    }
  });

  it('rejects a path, query, fragment or credentials in the public url', () => {
    for (const url of [
      'https://x.example/mcp',
      'https://x.example/?a=1',
      'https://x.example/#frag',
      'https://user@x.example/',
      'https://user:pw@x.example/',
    ]) {
      const err = failure({ ...BASE, MAILMCP_PUBLIC_URL: url });
      expect(err.code).toBe('config_invalid');
      expect(err.message).toContain('MAILMCP_PUBLIC_URL');
      expect(err.message).not.toContain(url);
    }
  });

  it('accepts a trailing slash and stores the origin only', () => {
    const config = loadRuntime({ ...BASE, MAILMCP_PUBLIC_URL: 'https://x.example/' });
    expect(config.publicUrl.origin).toBe('https://x.example');
    expect(config.publicUrl.pathname).toBe('/');
  });

  it('rejects a missing or invalid password hash without echoing it', () => {
    const rest = { ...BASE, MAILMCP_ADMIN_PASSWORD_HASH: undefined };
    expect(failure(rest).message).toContain('MAILMCP_ADMIN_PASSWORD_HASH');
    const bad = '$argon2id$not-a-real-hash-value';
    const err = failure({ ...BASE, MAILMCP_ADMIN_PASSWORD_HASH: bad });
    expect(err.message).toContain('MAILMCP_ADMIN_PASSWORD_HASH');
    expect(err.message).not.toContain(bad);
  });

  it('rejects a missing, invalid or short totp secret without echoing it', () => {
    const rest = { ...BASE, MAILMCP_TOTP_SECRET: undefined };
    expect(failure(rest).message).toContain('MAILMCP_TOTP_SECRET');
    const invalid = 'not*base32!secret';
    const invalidErr = failure({ ...BASE, MAILMCP_TOTP_SECRET: invalid });
    expect(invalidErr.message).toContain('MAILMCP_TOTP_SECRET');
    expect(invalidErr.message).not.toContain(invalid);
    const short = 'GEZDGNBVGY3TQOJ';
    const shortErr = failure({ ...BASE, MAILMCP_TOTP_SECRET: short });
    expect(shortErr.message).toContain('MAILMCP_TOTP_SECRET');
    expect(shortErr.message).not.toContain(short);
  });

  it('rejects an invalid behind-proxy flag', () => {
    expect(failure({ ...BASE, MAILMCP_BEHIND_PROXY: 'yes' }).message).toContain(
      'MAILMCP_BEHIND_PROXY',
    );
    expect(loadRuntime({ ...BASE, MAILMCP_BEHIND_PROXY: '0' }).behindProxy).toBe(false);
  });

  it('rejects a bad port or debug flag', () => {
    expect(failure({ ...BASE, MAILMCP_PORT: 'abc' }).message).toContain('MAILMCP_PORT');
    expect(failure({ ...BASE, MAILMCP_DEBUG: 'yes' }).message).toContain('MAILMCP_DEBUG');
  });

  it('allows debug only when both the public url and the host are loopback (D25, D30)', () => {
    expect(loadRuntime({ ...BASE, MAILMCP_DEBUG: '1' }).debug).toBe(true);
    const publicErr = failure({
      ...BASE,
      MAILMCP_PUBLIC_URL: 'https://mail.example.com',
      MAILMCP_DEBUG: '1',
    });
    expect(publicErr.code).toBe('config_invalid');
    expect(publicErr.message).toContain('D25');
    expect(publicErr.message).toContain('the protocol debug log only runs locally');
    const hostErr = failure({ ...BASE, MAILMCP_HOST: '0.0.0.0', MAILMCP_DEBUG: '1' });
    expect(hostErr.message).toContain('D25');
    expect(hostErr.message).toContain('the protocol debug log only runs locally');
  });
});

describe('isLoopbackHost', () => {
  it('recognises the loopback names', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ['0.0.0.0', 'mail.example.com', '192.168.1.5', '']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe('loadHealthTarget', () => {
  it('connects to the default host and port and sends the public host', () => {
    expect(loadHealthTarget({ MAILMCP_PUBLIC_URL: 'https://mail.example' })).toEqual({
      host: '127.0.0.1',
      port: 8787,
      hostHeader: 'mail.example',
    });
  });

  it('reaches a wildcard listen address through loopback', () => {
    const base = { MAILMCP_PUBLIC_URL: 'https://mail.example', MAILMCP_PORT: '9000' };
    expect(loadHealthTarget({ ...base, MAILMCP_HOST: '0.0.0.0' }).host).toBe('127.0.0.1');
    expect(loadHealthTarget({ ...base, MAILMCP_HOST: '::' }).host).toBe('::1');
    expect(loadHealthTarget({ ...base, MAILMCP_HOST: '10.0.0.5' })).toEqual({
      host: '10.0.0.5',
      port: 9000,
      hostHeader: 'mail.example',
    });
  });

  it('keeps the port of the public url in the host header', () => {
    expect(loadHealthTarget({ MAILMCP_PUBLIC_URL: 'http://127.0.0.1:8787' }).hostHeader).toBe(
      '127.0.0.1:8787',
    );
  });

  it('needs no secret but rejects a bad public url or port', () => {
    expect(() => loadHealthTarget({})).toThrow('MAILMCP_PUBLIC_URL is required.');
    expect(() => loadHealthTarget({ MAILMCP_PUBLIC_URL: 'http://mail.example' })).toThrow(
      'must use https',
    );
    expect(() =>
      loadHealthTarget({ MAILMCP_PUBLIC_URL: 'https://mail.example', MAILMCP_PORT: 'x' }),
    ).toThrow(MailError);
  });
});
