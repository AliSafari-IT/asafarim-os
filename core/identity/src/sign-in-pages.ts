/**
 * The HTML of the SMS sign-in and of the connections admin. Server-rendered,
 * no inline script (only the theme's and passkey's own files), every value escaped; each form carries its CSRF token.
 */
import type { AppLink } from "./clients.ts";
import { type NavLink, escapeHtml, homeHref, homeLink, page, PRODUCT_LINKS } from "./pages.ts";
import type { AuditRow, ConnectionRequestRow, ConnectionRow } from "./store.ts";

/** Pages that post forms to this origin only, and run only this origin's scripts (the theme's). */
export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** Pages with passkey buttons: also fetch to our own origin. */
export const PASSKEY_PAGE_CSP = `${PAGE_CSP}; connect-src 'self'`;

const EXTRA_STYLE = `<style>
label{display:block;font-weight:600;margin:0 0 6px}
input[type=tel],input[type=text],input[type=email]{width:100%;font:inherit;font-size:1.15rem;padding:10px 12px;border:1px solid var(--line);
border-radius:10px;background:var(--card-2);color:var(--ink);margin:0 0 14px}
input.code{letter-spacing:.35em;text-align:center;font-variant-numeric:tabular-nums}
.error{color:var(--bad);font-weight:600}
.notice{border-left:3px solid var(--accent);padding-left:10px}
form.inline{display:inline;margin:0}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.apps{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:8px}
.tile{display:flex;gap:12px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:12px;
color:var(--ink);text-decoration:none}.tile:hover{border-color:var(--accent)}
.tile small{display:block;color:var(--muted)}
.glyph{flex:none;display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--accent-soft);
color:var(--accent);font-weight:700;font-size:.8rem;letter-spacing:.04em}
.os-table-wrap{margin:0 0 20px}.os-table td{vertical-align:middle}
.details{color:var(--muted);font-size:.85em;overflow-wrap:anywhere}
h2{font-size:1.05rem;margin:22px 0 8px}
.small{font-size:.85rem}
button.danger{background:var(--bad);color:var(--bad-ink)}
</style>`;

const when = (d: Date | null) =>
  d ? `<span class="os-nowrap">${escapeHtml(d.toISOString().replace("T", " ").slice(0, 16))} UTC</span>` : "—";

/** A data table in @asafarim/theme's style: it scrolls on its own, and on a phone each row is a card. */
const table = (columns: string[], rows: string) =>
  `<div class="os-table-wrap"><table class="os-table os-table--stack"><thead><tr>${columns
    .map((c) => `<th scope="col">${c}</th>`)
    .join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
/** A cell with its column's name, shown in front of it when the row is a card. */
const cell = (label: string, html: string, className = "") =>
  `<td${className ? ` class="${className}"` : ""}${label ? ` data-label="${label}"` : ""}>${html}</td>`;
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

/**
 * The header of a signed-in page: Home, the account, and for an admin Connections and, when it is
 * configured, the Admin console (admin.asafarim.site, which still checks core.admin itself).
 */
function signedInNav(current: "account" | "admin", isAdmin: boolean, adminConsoleUrl?: string): NavLink[] {
  return [
    homeLink(),
    { href: "/account", label: "Account", current: current === "account" },
    ...(isAdmin ? [{ href: "/admin", label: "Connections", current: current === "admin" }] : []),
    ...(isAdmin && adminConsoleUrl ? [{ href: adminConsoleUrl, label: "Admin console" }] : []),
  ];
}

/** Up to two letters for a tile: "Docs" → "DO", "Core admin" → "CA". */
function glyphOf(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const first = words[0] ?? "?";
  return (words[1] ? first[0]! + words[1][0]! : first.slice(0, 2)).toUpperCase();
}

const tile = (href: string, glyph: string, name: string, description: string) =>
  `<li><a class="tile" href="${escapeHtml(href)}"><span class="glyph" aria-hidden="true">${escapeHtml(glyph)}</span>
<span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(description)}</small></span></a></li>`;

/**
 * "Where to next": the OS home page, then the apps that sign in here (access is still an admin's grant), then
 * ASafariM's products outside the OS, which open for everyone.
 */
function nextSteps(apps: readonly AppLink[], connected: boolean): string {
  const tiles = [
    tile(homeHref(), "OS", "ASafariM OS", "The home page: what the OS is, and what's new."),
    ...apps.map((a) => tile(a.href, glyphOf(a.name), a.name, a.description ?? new URL(a.href).host)),
  ].join("");
  const note = !apps.length
    ? ""
    : connected
      ? '<p class="small">An app opens once an admin has given your account access to it.</p>'
      : '<p class="small">Apps open once your account is connected and an admin has given it access.</p>';
  const more = PRODUCT_LINKS.map((p) => tile(p.href, glyphOf(p.name), p.name, p.description)).join("");
  return `<h2>Where to next</h2><ul class="apps">${tiles}</ul>${note}<h3>More from ASafariM</h3><ul class="apps">${more}</ul>`;
}

export function accountPage(opts: {
  csrf: string;
  /** The apps that sign in here and have a name in the client config. */
  apps: readonly AppLink[];
  /** The principal id: the `sub` every app sees, and what an admin grants an app's role to. */
  accountId: string;
  label: string | null;
  connected: boolean;
  isAdmin: boolean;
  /** Linked in the header for an admin. */
  adminConsoleUrl?: string;
  passkeys: { credentialId: string; name: string; createdAt: Date; lastUsedAt: Date | null }[];
  notice?: string;
}): string {
  const csrf = csrfField(opts.csrf);
  const list = opts.passkeys.length
    ? table(
        ["Passkey", "Added", "Last used", ""],
        opts.passkeys
          .map(
            (k) =>
              `<tr>${cell("Passkey", escapeHtml(k.name))}${cell("Added", when(k.createdAt))}${cell("Last used", when(k.lastUsedAt))}${cell(
                "",
                `<form class="inline" method="post" action="/account/passkeys/remove">${csrf}<input type="hidden" name="id" value="${escapeHtml(k.credentialId)}"><button class="secondary" type="submit">Remove</button></form>`,
              )}</tr>`,
          )
          .join(""),
      )
    : "<p>No passkeys yet.</p>";
  return page(
    "Your account",
    `<h1>Your account</h1>
${opts.notice ? `<p class="notice">${escapeHtml(opts.notice)}</p>` : ""}
<p>Signed in as <strong>${escapeHtml(opts.label ?? "—")}</strong>${opts.connected ? "" : " (not connected yet)"}.</p>
<p class="small">Account id: <code data-account-id>${escapeHtml(opts.accountId)}</code>. An admin uses it to give you access to an app.</p>
${nextSteps(opts.apps, opts.connected)}
<h2>Passkeys</h2>
<p class="small">A passkey lets you sign in with your fingerprint, face or device PIN instead of a code.</p>
${list}
<p><button type="button" data-passkey="register" data-csrf="${escapeHtml(opts.csrf)}" hidden>Add a passkey</button></p>
<p class="small" data-passkey-status role="status"></p>
<form method="post" action="/logout">${csrf}<button class="secondary" type="submit" style="margin-left:0">Sign out</button></form>`,
    {
      head: `${EXTRA_STYLE}<style>.card{max-width:640px}</style><script src="/static/passkey.js" defer></script>`,
      nav: signedInNav("account", opts.isAdmin, opts.adminConsoleUrl),
    },
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
  /** Linked in the header. */
  adminConsoleUrl?: string;
  notice?: string;
  error?: string;
}): string {
  const csrf = csrfField(opts.csrf);
  const requests = opts.requests.length
    ? table(
        ["Who", "Requested", ""],
        opts.requests
          .map(
            (r) =>
              `<tr>${cell("Who", labelCell(r.label))}${cell("Requested", when(r.createdAt))}${cell(
                "",
                `<div class="row">
<form class="inline" method="post" action="/admin/requests/${escapeHtml(r.id)}/approve">${csrf}<button type="submit">Approve</button></form>
<form class="inline" method="post" action="/admin/requests/${escapeHtml(r.id)}/reject">${csrf}<button class="secondary" type="submit">Reject</button></form>
</div>`,
              )}</tr>`,
          )
          .join(""),
      )
    : "<p>No pending requests.</p>";

  const connections = opts.connections.length
    ? table(
        ["Who", "Status", "Granted", "Last sign-in", ""],
        opts.connections
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
            return `<tr>${cell("Who", `${labelCell(c.label)}${c.isAdmin ? ' <span class="small">(admin)</span>' : ""}`)}${cell(
              "Status",
              `${escapeHtml(c.status)}${c.revokedAt ? ` <span class="small">${when(c.revokedAt)}</span>` : ""}`,
            )}${cell("Granted", when(c.grantedAt))}${cell("Last sign-in", when(c.lastLoginAt))}${cell("", action)}</tr>`;
          })
          .join(""),
      )
    : "<p>No connections.</p>";

  const audit = opts.audit.length
    ? table(
        ["When", "Event", "Who", "Details"],
        opts.audit
          .map(
            (a) =>
              `<tr>${cell("When", when(a.at))}${cell("Event", `<span class="os-nowrap">${escapeHtml(a.event)}</span>`)}${cell(
                "Who",
                a.label ? escapeHtml(a.label) : "—",
              )}${cell(
                "Details",
                `<span class="details">${escapeHtml(
                  Object.entries(a.detail)
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(" "),
                )}</span>`,
              )}</tr>`,
          )
          .join(""),
      )
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
    {
      head: `${EXTRA_STYLE}<style>.card{max-width:880px}</style>`,
      nav: signedInNav("admin", true, opts.adminConsoleUrl),
    },
  );
}
