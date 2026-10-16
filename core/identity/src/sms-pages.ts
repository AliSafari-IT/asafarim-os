/**
 * The HTML of the SMS sign-in and of the connections admin. Server-rendered,
 * no script, every value escaped; each form carries its CSRF token.
 */
import { escapeHtml, page } from "./pages.ts";
import { maskPhone } from "./phone.ts";
import type { AuditRow, ConnectionRequestRow, ConnectionRow } from "./store.ts";

/** Pages that post forms to this origin only. */
export const SMS_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

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

const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
const err = (message?: string) => (message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : "");

export function phonePage(opts: { csrf: string; error?: string; value?: string }): string {
  return page(
    "Sign in",
    `<h1>Sign in</h1>
<p>Enter your mobile number. We'll send you a sign-in code by SMS.</p>
${err(opts.error)}
<form method="post" action="/login/phone">
${csrfField(opts.csrf)}
<label for="phone">Mobile number</label>
<input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength="32"
 placeholder="+32 470 12 34 56" value="${escapeHtml(opts.value ?? "")}" autofocus>
<p class="small">Use the international format, starting with + and your country code.</p>
<button type="submit">Send code</button>
</form>`,
    EXTRA_STYLE,
  );
}

export function codePage(opts: { csrf: string; phone: string; error?: string }): string {
  return page(
    "Enter your code",
    `<h1>Enter your code</h1>
<p>If this number can receive SMS, a 6-digit code is on its way to <strong>${escapeHtml(maskPhone(opts.phone))}</strong>. It expires in 5 minutes.</p>
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
<a class="button secondary" href="/login/restart">Use another number</a>
</div>`,
    EXTRA_STYLE,
  );
}

export function notConnectedPage(opts: { csrf: string; pending: boolean; justRequested?: boolean }): string {
  const body = opts.pending
    ? `<h1>Request pending</h1>
<p class="notice">${opts.justRequested ? "Your request has been sent." : "You've already asked to be connected."} An administrator will review it. Once it's approved, sign in again with this number.</p>`
    : `<h1>Not connected yet</h1>
<p>Your number is verified, but it isn't connected to ASafariM. You can ask an administrator to connect it.</p>
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

const when = (d: Date | null) => (d ? escapeHtml(d.toISOString().replace("T", " ").slice(0, 16)) + " UTC" : "—");
const phoneCell = (phone: string | null) => (phone ? escapeHtml(phone) : "<em>no number</em>");

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
    ? `<table><thead><tr><th>Number</th><th>Requested</th><th></th></tr></thead><tbody>${opts.requests
        .map(
          (r) => `<tr><td>${phoneCell(r.phone)}</td><td>${when(r.createdAt)}</td><td class="row">
<form class="inline" method="post" action="/admin/requests/${escapeHtml(r.id)}/approve">${csrf}<button type="submit">Approve</button></form>
<form class="inline" method="post" action="/admin/requests/${escapeHtml(r.id)}/reject">${csrf}<button class="secondary" type="submit">Reject</button></form>
</td></tr>`,
        )
        .join("")}</tbody></table>`
    : "<p>No pending requests.</p>";

  const connections = opts.connections.length
    ? `<table><thead><tr><th>Number</th><th>Status</th><th>Granted</th><th>Last sign-in</th><th></th></tr></thead><tbody>${opts.connections
        .map((c) => {
          const self = c.principalId === opts.me;
          const action =
            c.status === "active" && !self
              ? `<form class="inline" method="post" action="/admin/connections/${escapeHtml(c.principalId)}/revoke">${csrf}<button class="danger" type="submit">Revoke</button></form>`
              : c.status === "revoked" && c.phone
                ? `<form class="inline" method="post" action="/admin/connections">${csrf}<input type="hidden" name="phone" value="${escapeHtml(c.phone)}"><button class="secondary" type="submit" style="margin-left:0">Reconnect</button></form>`
                : self
                  ? `<span class="small">you</span>`
                  : "";
          return `<tr><td>${phoneCell(c.phone)}${c.isAdmin ? ' <span class="small">(admin)</span>' : ""}</td><td>${escapeHtml(c.status)}${c.revokedAt ? ` <span class="small">${when(c.revokedAt)}</span>` : ""}</td><td>${when(c.grantedAt)}</td><td>${when(c.lastLoginAt)}</td><td>${action}</td></tr>`;
        })
        .join("")}</tbody></table>`
    : "<p>No connections.</p>";

  const audit = opts.audit.length
    ? `<table class="small"><thead><tr><th>When</th><th>Event</th><th>Number</th><th>Details</th></tr></thead><tbody>${opts.audit
        .map(
          (a) =>
            `<tr><td>${when(a.at)}</td><td>${escapeHtml(a.event)}</td><td>${a.phone ? escapeHtml(maskPhone(a.phone)) : "—"}</td><td>${escapeHtml(
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
<h2>Connect a number</h2>
<form method="post" action="/admin/connections" class="row">${csrf}
<input name="phone" type="tel" inputmode="tel" required maxlength="32" placeholder="+32 470 12 34 56" style="max-width:260px;margin:0" aria-label="Mobile number">
<button type="submit">Connect</button></form>
<h2>Connections</h2>${connections}
<h2>Recent activity</h2>${audit}
<form method="post" action="/logout">${csrf}<button class="secondary" type="submit" style="margin-left:0">Sign out</button></form>`,
    `${EXTRA_STYLE}<style>main{max-width:880px}</style>`,
  );
}
