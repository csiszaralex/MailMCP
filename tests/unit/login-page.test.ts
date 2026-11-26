import { describe, expect, it } from 'vitest';
import {
  loginPageHeaders,
  PAGE_HEADERS,
  renderErrorPage,
  renderLoginPage,
  type LoginView,
} from '../../src/auth/login-page.js';

const VIEW: LoginView = {
  clientHost: 'claude.ai',
  redirectHost: 'claude.ai',
  redirectOrigin: 'https://claude.ai',
  resource: 'https://mail.example/mcp',
  loopbackRedirect: false,
  error: undefined,
};

const LOOPBACK_WARNING = 'The answer goes to a program on this computer';

describe('renderLoginPage', () => {
  it('shows the client host, the redirect host and the resource', () => {
    const html = renderLoginPage('req-1', { ...VIEW, redirectHost: 'callback.example' });
    expect(html).toContain('Sign in to MailMCP');
    expect(html).toContain('claude.ai wants access to https://mail.example/mcp');
    expect(html).toContain('callback.example');
  });

  it('escapes every interpolated value', () => {
    const html = renderLoginPage('"><script>x</script>', {
      clientHost: '<script>alert(1)</script>',
      redirectHost: '<b>r</b>&',
      redirectOrigin: 'https://r.example',
      resource: `https://x.example/'"`,
      loopbackRedirect: true,
      error: '<i>bad</i>',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;r&lt;/b&gt;&amp;');
    expect(html).toContain('https://x.example/&#39;&quot;');
    expect(html).toContain('&lt;i&gt;bad&lt;/i&gt;');
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
  });

  it('warns about a loopback redirect only when it is one', () => {
    expect(renderLoginPage('req-1', VIEW)).not.toContain(LOOPBACK_WARNING);
    const html = renderLoginPage('req-1', {
      ...VIEW,
      redirectHost: '127.0.0.1:53124',
      loopbackRedirect: true,
    });
    expect(html).toContain(
      'The answer goes to a program on this computer (127.0.0.1:53124). Continue only if you started the sign-in yourself.',
    );
  });

  it('shows the error only when set', () => {
    expect(renderLoginPage('req-1', VIEW)).not.toContain('Invalid password or code.');
    expect(renderLoginPage('req-1', { ...VIEW, error: 'Invalid password or code.' })).toContain(
      'Invalid password or code.',
    );
  });

  it('posts the request id, the password and the totp code to /authorize', () => {
    const html = renderLoginPage('req-1', VIEW);
    expect(html).toContain('<form method="post" action="/authorize">');
    expect(html).toContain('<input type="hidden" name="request" value="req-1">');
    expect(html).toMatch(
      /<input[^>]*name="password" type="password" autocomplete="current-password" required>/,
    );
    expect(html).toMatch(
      /<input[^>]*name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="\[0-9\]\{6\}" maxlength="6" required>/,
    );
  });

  it('has no script and no external resource', () => {
    const html = renderLoginPage('req-1', { ...VIEW, loopbackRedirect: true });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/\ssrc=/i);
    expect(html).toContain('<style>');
  });
});

describe('renderErrorPage', () => {
  it('shows the escaped message without a form', () => {
    const html = renderErrorPage('client_id <x> is not allowed.');
    expect(html).toContain('client_id &lt;x&gt; is not allowed.');
    expect(html).not.toContain('<form');
    expect(html).not.toMatch(/<script/i);
  });
});

describe('loginPageHeaders', () => {
  it('lets the form redirect to the redirect_uri origin and nowhere else', () => {
    const headers = loginPageHeaders({ ...VIEW, redirectOrigin: 'http://127.0.0.1:53124' });
    expect(headers['Content-Security-Policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://127.0.0.1:53124; frame-ancestors 'none'",
    );
    expect({
      ...headers,
      'Content-Security-Policy': undefined,
      'Referrer-Policy': undefined,
    }).toEqual({
      ...PAGE_HEADERS,
      'Content-Security-Policy': undefined,
      'Referrer-Policy': undefined,
    });
  });

  it('uses Referrer-Policy same-origin, so the form POST carries a real Origin', () => {
    // Under no-referrer the Fetch standard serializes the POST's Origin as "null", and
    // POST /authorize answers 403 to any Origin but its own.
    const headers = loginPageHeaders(VIEW);
    expect(headers['Referrer-Policy']).toBe('same-origin');
    expect(headers['Referrer-Policy']).not.toBe(PAGE_HEADERS['Referrer-Policy']);
  });
});

describe('PAGE_HEADERS', () => {
  it('carries the D31 security headers', () => {
    expect(PAGE_HEADERS).toEqual({
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': 'text/html; charset=utf-8',
    });
  });
});
