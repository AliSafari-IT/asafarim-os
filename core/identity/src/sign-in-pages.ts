/**
 * The HTML of the SMS sign-in and of the connections admin. Server-rendered,
 * no script, every value escaped; each form carries its CSRF token.
 */
import { escapeHtml, page } from "./pages.ts";
import type { AuditRow, ConnectionRequestRow, ConnectionRow } from "./store.ts";

/** Pages that post forms to this origin only. */
export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** Pages with passkey buttons: our one script, and fetch to our own origin. */
export const PASSKEY_PAGE_CSP = `${PAGE_CSP}; script-src 'self'; connect-src 'self'`;

const EXTRA_STYLE = `<style>
label{display:block;font-weight:600;margin:0 0 6px}
input[type=tel],input[type=text]{width:100%;font:inherit;font-size:1.15rem;padding:10px 12px;border:1px solid var(--line);
border-radius:10px;background:var(--bg);color:var(--ink);margin:0 0 14px}
input.code{letter-spacing:.35em;text-align:center;font-variant-numeric:tabular-nums}
.error{color:#b42318;font-weight:600}@media (prefers-color-scheme:dark){.error{color:#f97066}}
.notice{border-left:3px solid var(--accent);padding-left:10px}
form.inline{display:inline;margin:0}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.wide main{max-width:880px}
table{width:100%;border-collapse:collapse;margin:0 0 20px;font-size:.92rem}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--muted);font-weight:600}
h2{font-size:1.05rem;margin:22px 0 8px}
.small{font-size:.85rem}
button.danger{background:#b42318}
</style>`;

const when = (d: Date | null) => (d ? escapeHtml(d.toISOString().replace("T", " ").slice(0, 16)) + " UTC" : "—");
const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
const err = (message?: string) => (message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : "");

export interface LoginPageOptions {
  csrf: string;
  email: boolean;
  sms: boolean;
  passkey: boolean;
  error?: string;
  /** What was typed, shown again after an error. */
  value?: string;
}

export function loginPage(o: LoginPageOptions): string {
  const passkey = o.passkey
    ? `<p><button type="button" data-passkey="login" data-csrf="${escapeHtml(o.csrf)}" hidden>Sign in with a passkey</button></p>
<p class="small" data-passkey-status role="status"></p>`
    : "";
  const email = o.email
    ? `<form method="post" action="/login/start">
${csrfField(o.csrf)}<input type="hidden" name="via" value="email">
<label for="email">Email address</label>
<input id="email" name="identifier" type="email" autocomplete="email" required maxlength="254"
 placeholder="you@example.com" value="${escapeHtml(o.value && o.value.includes("@") ? o.value : "")}">
<button type="submit">Email me a code</button>
</form>`
    : "";
  const sms = o.sms
    ? `<form method="post" action="/login/start" style="margin-top:18px">
${csrfField(o.csrf)}<input type="hidden" name="via" value="sms">
<label for="phone">Mobile number</label>
<input id="phone" name="identifier" type="tel" inputmode="tel" autocomplete="tel" required maxlength="32"
 placeholder="+32 470 12 34 56" value="${escapeHtml(o.value && !o.value.includes("@") ? o.value : "")}">
<button type="submit">Text me a code</button>
</form>`
    : "";
  return page(
    "Sign in",
    `<h1>Sign in</h1>
${err(o.error)}${passkey}${email}${sms}`,
    `${EXTRA_STYLE}${o.passkey ? '<script src="/static/passkey.js" defer></script>' : ""}`,
  );
}

export function codePage(opts: { csrf: string; masked: string; via: "email" | "sms"; error?: string }): string {
  const where = opts.via === "email" ? "this address" : "this number";
  const what = opts.via === "email" ? "an email" : "an SMS";
  return page(
    "Enter your code",
    `<h1>Enter your code</h1>
<p>If ${where} can sign in, ${what} with a 6-digit code is on its way to <strong>${escapeHtml(opts.masked)}</strong>. It expires in 5 minutes.</p>
${err(opts.error)}
<form method="post" action="/login/verify">
${csrfField(opts.csrf)}
<label for="code">Code</label>
<input id="code" name="code" class="code" type="text" inputmode="numeric" autocomplete="one-time-code"
 pattern="[0-9]{6}" maxlength="6" required autofocus>
<button type="submit">Verify</button>
</form>
<div class="row" style="margin-top:14px">
<form class="inline" method="post" action="/login/resend">${csrfField(opts.csrf)}<button class="secondary" type="submit" style="margin-left:0">Send a new code</button></form>
<a class="button secondary" href="/login/restart">Start again</a>
</div>`,
    EXTRA_STYLE,
  );
}

export function accountPage(opts: {
  csrf: string;
  /** The principal id: the `sub` every app sees, and what an admin grants an app's role to. */
  accountId: string;
  label: string | null;
  connected: boolean;
  isAdmin: boolean;
  passkeys: { credentialId: string; name: string; createdAt: Date; lastUsedAt: Date | null }[];
  notice?: string;
}): string {
  const csrf = csrfField(opts.csrf);
  const list = opts.passkeys.length
    ? `<table><thead><tr><th>Passkey</th><th>Added</th><th>Last used</th><th></th></tr></thead><tbody>${opts.passkeys
        .map(
          (k) => `<tr><td>${escapeHtml(k.name)}</td><td>${when(k.createdAt)}</td><td>${when(k.lastUsedAt)}</td><td>
<form class="inline" method="post" action="/account/passkeys/remove">${csrf}<input type="hidden" name="id" value="${escapeHtml(k.credentialId)}"><button class="secondary" type="submit">Remove</button></form></td></tr>`,
        )
        .join("")}</tbody></table>`
    : "<p>No passkeys yet.</p>";
  return page(
    "Your account",
    `<h1>Your account</h1>
${opts.notice ? `<p class="notice">${escapeHtml(opts.notice)}</p>` : ""}
<p>Signed in as <strong>${escapeHtml(opts.label ?? "—")}</strong>${opts.connected ? "" : " (not connected yet)"}.</p>
<p class="small">Account id: <code data-account-id>${escapeHtml(opts.accountId)}</code>. An admin uses it to give you access to an app.</p>
<h2>Passkeys</h2>
<p class="small">A passkey lets you sign in with your fingerprint, face or device PIN instead of a code.</p>
${list}
<p><button type="button" data-passkey="register" data-csrf="${escapeHtml(opts.csrf)}" hidden>Add a passkey</button></p>
<p class="small" data-passkey-status role="status"></p>
${opts.isAdmin ? '<p><a class="button secondary" href="/admin" style="margin-left:0">Connections (admin)</a></p>' : ""}
<form method="post" action="/logout">${csrf}<button class="secondary" type="submit" style="margin-left:0">Sign out</button></form>`,
    `${EXTRA_STYLE}<style>main{max-width:640px}</style><script src="/static/passkey.js" defer></script>`,
  );
}

export function notConnectedPage(opts: { csrf: string; pending: boolean; justRequested?: boolean }): string {
  const body = opts.pending
    ? `<h1>Request pending</h1>
<p class="notice">${opts.justRequested ? "Your request has been sent." : "You've already asked to be connected."} An administrator will review it. Once it's approved, sign in again.</p>`
    : `<h1>Not connected yet</h1>
<p>You're verified, but you aren't connected to ASafariM. You can ask an administrator to connect it.</p>
<form method="post" action="/login/request">${csrfField(opts.csrf)}<button type="submit">Request connection</button></form>`;
  return page(
    opts.pending ? "Request pending" : "Not connected",
    `${body}
<form method="post" action="/logout" style="margin-top:16px">${csrfField(opts.csrf)}<button class="secondary" type="submit" style="margin-left:0">Sign out</button></form>`,
    EXTRA_STYLE,
  );
}

export function messagePage(opts: { title: string; message: string; link?: { href: string; label: string } }): string {
  const link = opts.link
    ? `<p><a class="button" href="${escapeHtml(opts.link.href)}">${escapeHtml(opts.link.label)}</a></p>`
    : "";
  return page(opts.title, `<h1>${escapeHtml(opts.title)}</h1><p>${escapeHtml(opts.message)}</p>${link}`, EXTRA_STYLE);
}

/**
 * Where a successful sign-in continues. Not a redirect: the code was POSTed with `form-action 'self'`,
 * and Chromium applies form-action to every redirect of that submission, so the hop to the app's
 * domain would be blocked. A meta refresh is a new navigation; a visible link is the fallback.
 * `href` is built by the server from a fixed path or the configured home URL, and escaped anyway.
 */
export function continueToPage(href: string): string {
  const safe = escapeHtml(href);
  return page(
    "Signed in",
    `<h1>You're signed in</h1><p>Taking you on…</p><p><a class="button" href="${safe}">Continue</a></p>`,
    `<meta http-equiv="refresh" content="0;url=${safe}">`,
  );
}

const labelCell = (label: string | null) => (label ? escapeHtml(label) : "<em>none</em>");

export function adminPage(opts: {
  csrf: string;
  me: string;
  requests: ConnectionRequestRow[];
  connections: ConnectionRow[];
  audit: AuditRow[];
  notice?: string;
  error?: string;
}): string {
  const csrf = csrfField(opts.csrf);
  const requests = opts.requests.length
    ? `<table><thead><tr><th>Who</th><th>Requested</th><th></th></tr></thead><tbody>${opts.requests
        .map(
          (r) => `<tr><td>${labelCell(r.label)}</td><td>${when(r.createdAt)}</td><td class="row">
<form class="inline" method="post" action="/admin/requests/${escapeHtml(r.id)}/approve">${csrf}<button type="submit">Approve</button></form>
<form class="inline" method="post" action="/admin/requests/${escapeHtml(r.id)}/reject">${csrf}<button class="secondary" type="submit">Reject</button></form>
</td></tr>`,
        )
        .join("")}</tbody></table>`
    : "<p>No pending requests.</p>";

  const connections = opts.connections.length
    ? `<table><thead><tr><th>Who</th><th>Status</th><th>Granted</th><th>Last sign-in</th><th></th></tr></thead><tbody>${opts.connections
        .map((c) => {
          const self = c.principalId === opts.me;
          const action =
            c.status === "active" && !self
              ? `<form class="inline" method="post" action="/admin/connections/${escapeHtml(c.principalId)}/revoke">${csrf}<button class="danger" type="submit">Revoke</button></form>`
              : c.status === "revoked" && c.label
                ? `<form class="inline" method="post" action="/admin/connections">${csrf}<input type="hidden" name="identifier" value="${escapeHtml(c.label)}"><button class="secondary" type="submit" style="margin-left:0">Reconnect</button></form>`
                : self
                  ? `<span class="small">you</span>`
                  : "";
          return `<tr><td>${labelCell(c.label)}${c.isAdmin ? ' <span class="small">(admin)</span>' : ""}</td><td>${escapeHtml(c.status)}${c.revokedAt ? ` <span class="small">${when(c.revokedAt)}</span>` : ""}</td><td>${when(c.grantedAt)}</td><td>${when(c.lastLoginAt)}</td><td>${action}</td></tr>`;
        })
        .join("")}</tbody></table>`
    : "<p>No connections.</p>";

  const audit = opts.audit.length
    ? `<table class="small"><thead><tr><th>When</th><th>Event</th><th>Who</th><th>Details</th></tr></thead><tbody>${opts.audit
        .map(
          (a) =>
            `<tr><td>${when(a.at)}</td><td>${escapeHtml(a.event)}</td><td>${a.label ? escapeHtml(a.label) : "—"}</td><td>${escapeHtml(
              Object.entries(a.detail)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(" "),
            )}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : "<p>Nothing yet.</p>";

  return page(
    "Connections",
    `<h1>Connections</h1>
${opts.notice ? `<p class="notice">${escapeHtml(opts.notice)}</p>` : ""}${err(opts.error)}
<h2>Pending requests</h2>${requests}
<h2>Connect someone</h2>
<form method="post" action="/admin/connections" class="row">${csrf}
<input name="identifier" type="text" required maxlength="254" placeholder="email or +32 470 12 34 56" style="max-width:300px;margin:0" aria-label="Email address or mobile number">
<button type="submit">Connect</button></form>
<h2>Connections</h2>${connections}
<h2>Recent activity</h2>${audit}
<form method="post" action="/logout">${csrf}<button class="secondary" type="submit" style="margin-left:0">Sign out</button></form>`,
    `${EXTRA_STYLE}<style>main{max-width:880px}</style>`,
  );
}
