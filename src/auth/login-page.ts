/** What the login page shows about the pending authorization request (D31). */
export interface LoginView {
  /** Host of the client_id URL, not the document's self-declared client_name. */
  clientHost: string;
  redirectHost: string;
  /** Origin of the redirect_uri: the login page's CSP must let the form's redirect go there. */
  redirectOrigin: string;
  resource: string;
  loopbackRedirect: boolean;
  error: string | undefined;
}

function csp(formAction: string): string {
  return `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'`;
}

/**
 * D31 headers for the error page; the pages carry inline styles and nothing else. The error page
 * has no form and no link, so no-referrer costs nothing there and never leaks its URL (which
 * carries the client's state) anywhere.
 */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': csp("'self'"),
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Type': 'text/html; charset=utf-8',
};

/**
 * D31 headers for the login page. Chrome applies form-action to the redirect that answers the
 * form too, so the redirect_uri's origin is allowed besides 'self'. The origin comes from
 * URL.origin, which cannot carry a space or a semicolon.
 *
 * Referrer-Policy is same-origin, not no-referrer: under no-referrer the Fetch standard serializes
 * the form POST's Origin header as "null", and POST /authorize refuses every Origin but its own.
 * same-origin still sends no referrer to another origin, the client's redirect_uri included.
 */
export function loginPageHeaders(view: LoginView): Readonly<Record<string, string>> {
  return {
    ...PAGE_HEADERS,
    'Content-Security-Policy': csp(`'self' ${view.redirectOrigin}`),
    'Referrer-Policy': 'same-origin',
  };
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const STYLE = `
body { font-family: system-ui, sans-serif; max-width: 26rem; margin: 3rem auto; padding: 0 1rem;
  color: #1f2328; background: #fff; }
h1 { font-size: 1.4rem; }
label { display: block; margin-top: 1rem; }
input[type=password], input[name=totp] { display: block; width: 100%; box-sizing: border-box;
  padding: 0.5rem; margin-top: 0.25rem; font-size: 1rem; }
button { margin-top: 1.5rem; padding: 0.6rem 1.2rem; font-size: 1rem; }
.warning { padding: 0.75rem; border: 1px solid #bf8700; background: #fff8c5; }
.error { padding: 0.75rem; border: 1px solid #cf222e; background: #ffebe9; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

export function renderLoginPage(requestId: string, view: LoginView): string {
  const warning = view.loopbackRedirect
    ? `<p class="warning">The answer goes to a program on this computer (${escapeHtml(view.redirectHost)}). Continue only if you started the sign-in yourself.</p>`
    : '';
  const error = view.error === undefined ? '' : `<p class="error">${escapeHtml(view.error)}</p>`;
  return page(
    'Sign in to MailMCP',
    `<h1>Sign in to MailMCP</h1>
<p>${escapeHtml(view.clientHost)} wants access to ${escapeHtml(view.resource)}</p>
<p>After sign-in you return to ${escapeHtml(view.redirectHost)}.</p>
${warning}
${error}
<form method="post" action="/authorize">
<input type="hidden" name="request" value="${escapeHtml(requestId)}">
<label>Password
<input name="password" type="password" autocomplete="current-password" required>
</label>
<label>Authenticator code
<input name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
</label>
<button type="submit">Sign in</button>
</form>`,
  );
}

export function renderErrorPage(message: string): string {
  return page(
    'MailMCP sign-in error',
    `<h1>Sign-in cannot continue</h1>
<p class="error">${escapeHtml(message)}</p>`,
  );
}
