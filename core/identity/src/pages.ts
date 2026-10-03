/**
 * The service's own HTML: the error page (oidc-provider's renderError and
 * every hand-off failure), the logout confirmation and the logged-out page.
 * Small, self-contained (no external fonts or scripts), ASafariM-styled.
 */
const STYLE = `
:root{color-scheme:light dark;--bg:#f6f4ef;--card:#fff;--ink:#1d1b16;--muted:#5d584d;--accent:#9f4a07;--line:#e4dfd3}
@media (prefers-color-scheme:dark){:root{--bg:#15130f;--card:#1f1c17;--ink:#f1ece2;--muted:#b3ab9b;--accent:#e08a3c;--line:#37322a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);
font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
main{max-width:440px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
.brand{font-weight:700;letter-spacing:.02em;color:var(--accent);margin:0 0 18px}
h1{font-size:1.35rem;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}
button,.button{display:inline-block;border:0;border-radius:10px;background:var(--accent);color:#fff;font:inherit;font-weight:600;
padding:10px 16px;cursor:pointer;text-decoration:none}
.secondary{background:transparent;color:var(--muted);border:1px solid var(--line);margin-left:8px}
code{font-size:.85em;color:var(--muted)}`;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)} · ASafariM</title><style>${STYLE}</style></head>
<body><main><p class="brand">ASafariM</p>${body}</main></body></html>`;
}

/** A sign-in failure. Shows a code, never token contents or account data. */
export function errorPage(opts: { title?: string; message: string; code?: string }): string {
  const code = opts.code ? `<p><code>${escapeHtml(opts.code)}</code></p>` : "";
  return page(
    opts.title ?? "Sign-in didn't complete",
    `<h1>${escapeHtml(opts.title ?? "Sign-in didn't complete")}</h1><p>${escapeHtml(opts.message)}</p>${code}
<p>Go back to the app and start signing in again.</p>`,
  );
}

/** RP-initiated logout confirmation; `form` is oidc-provider's hidden form (xsrf). */
export function logoutPage(form: string): string {
  return page(
    "Sign out",
    `<h1>Sign out?</h1><p>You'll be signed out of ASafariM apps that use this sign-in.</p>${form}
<button form="op.logoutForm" name="logout" value="yes" autofocus>Sign out</button>
<button form="op.logoutForm" class="secondary">Stay signed in</button>`,
  );
}

export function loggedOutPage(): string {
  return page("Signed out", "<h1>You're signed out</h1><p>You can close this tab.</p>");
}
