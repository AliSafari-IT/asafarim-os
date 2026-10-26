/**
 * The HTML of the local sign-in, the account page, access requests and the connections admin. Server-rendered,
 * no inline script (only the theme's and passkey's own files), every value escaped; each form carries its CSRF token.
 * Phone first: one column, full-width actions; from 760px the sign-in page gets a second column that explains
 * how access works.
 */
import type { AppLink } from "./clients.ts";
import { type NavLink, escapeHtml, homeHref, homeLink, page, PRODUCT_LINKS } from "./pages.ts";
import type { AuditRow, ConnectionRequestRow, ConnectionRow, IdentityMethod, PendingRequest } from "./store.ts";

/** Pages that post forms to this origin only, and run only this origin's scripts (the theme's). */
export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** Pages with passkey buttons: also fetch to our own origin. */
export const PASSKEY_PAGE_CSP = `${PAGE_CSP}; connect-src 'self'`;

/** The most a note to the admin may hold (connection_requests.note). */
export const NOTE_MAX = 500;

const EXTRA_STYLE = `<style>
label{display:block;font-weight:600;margin:0 0 6px}
input[type=tel],input[type=text],input[type=email],textarea{width:100%;font:inherit;font-size:1.05rem;padding:11px 12px;
border:1px solid var(--line);border-radius:10px;background:var(--card-2);color:var(--ink);margin:0 0 14px}
textarea{min-height:84px;resize:vertical;font-size:1rem}
input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:1px}
input.code{font-size:1.6rem;letter-spacing:.45em;text-align:center;font-variant-numeric:tabular-nums;padding:12px 8px}
.error{color:var(--bad);font-weight:600}
.notice{border-left:3px solid var(--accent);padding:8px 12px;background:var(--accent-soft);border-radius:0 10px 10px 0;color:var(--ink)}
form.inline{display:inline;margin:0}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.apps{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:8px}
@media (min-width:640px){.apps.two{grid-template-columns:1fr 1fr}}
.tile{display:flex;gap:12px;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:12px;
color:var(--ink);text-decoration:none;background:var(--card)}.tile:hover{border-color:var(--accent)}
.tile small{display:block;color:var(--muted)}
.glyph{flex:none;display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--accent-soft);
color:var(--accent);font-weight:700;font-size:.8rem;letter-spacing:.04em}
.os-table-wrap{margin:0 0 20px}.os-table td{vertical-align:middle}
.keys{list-style:none;margin:0 0 16px;padding:0;display:grid;gap:8px}
.key{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 12px;border:1px solid var(--line);
border-radius:12px}.key strong{overflow-wrap:anywhere}.key small{display:block;color:var(--muted)}
.details{color:var(--muted);font-size:.85em;overflow-wrap:anywhere}
h2{font-size:1.05rem;margin:24px 0 8px}h3{font-size:.95rem;margin:18px 0 8px}
.small{font-size:.85rem}
button.danger{background:var(--bad);color:var(--bad-ink)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px;padding:0;list-style:none}
td .chips{margin:0}
td strong{overflow-wrap:anywhere}
.chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line);border-radius:999px;padding:2px 10px;
font-size:.8rem;font-weight:600;color:var(--ink);background:var(--card-2);white-space:nowrap}
.pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:.78rem;font-weight:700;letter-spacing:.02em}
.pill.ok{background:color-mix(in srgb,var(--good) 16%,transparent);color:var(--good)}
.pill.wait{background:var(--warn-bg);color:var(--warn)}
.pill.off{background:var(--accent-soft);color:var(--muted)}
.steps{list-style:none;display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:4px 0 20px;padding:0;counter-reset:s}
.steps li{position:relative;padding-top:30px;font-size:.78rem;font-weight:600;color:var(--muted);text-align:center;line-height:1.25}
.steps li::before{counter-increment:s;content:counter(s);position:absolute;top:0;left:50%;transform:translateX(-50%);
width:24px;height:24px;border-radius:50%;display:grid;place-items:center;border:2px solid var(--line);background:var(--card);
font-size:.75rem;color:var(--muted)}
.steps li.done::before{content:"✓";background:var(--good);border-color:var(--good);color:var(--card)}
.steps li.now{color:var(--ink)}.steps li.now::before{border-color:var(--accent);color:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
.pick{display:grid;gap:8px;margin:0 0 14px;padding:0;border:0}
.pick legend{font-weight:600;margin:0 0 8px;padding:0}
.pick label{display:flex;gap:12px;align-items:center;font-weight:400;margin:0;padding:10px 12px;border:1px solid var(--line);
border-radius:12px;cursor:pointer;background:var(--card)}
.pick label:has(input:checked){border-color:var(--accent);background:var(--accent-soft)}
.pick input{width:18px;height:18px;accent-color:var(--accent);flex:none;margin:0}
.pick small{display:block;color:var(--muted)}
.status{border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:0 0 16px;background:var(--card-2)}
.status p{margin:0 0 8px}.status p:last-child{margin:0}
details.more{margin:12px 0 0;border-top:1px solid var(--line);padding-top:10px}
details.more summary{cursor:pointer;color:var(--accent);font-weight:600;padding:4px 0}
details.more[open] summary{margin-bottom:10px}
.who{display:flex;gap:14px;align-items:center;margin:0 0 6px}
.avatar{flex:none;display:grid;place-items:center;width:48px;height:48px;border-radius:50%;background:var(--accent);
color:var(--accent-ink);font-weight:700;letter-spacing:.03em}
.who strong{display:block;overflow-wrap:anywhere;color:var(--ink)}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:8px 0 4px}
.stat{border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:var(--card-2)}
.stat b{display:block;font-size:1.4rem;line-height:1.1;color:var(--ink)}.stat span{font-size:.8rem;color:var(--muted)}
.note{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink);font-size:.9rem}
</style>`;

/** The sign-in page's own layout: two columns from 760px, the sign-in column first on a phone. */
const LOGIN_STYLE = `<style>
main>.card{max-width:940px;padding:0;overflow:hidden}
.split{display:grid}
.signin{padding:28px 24px}
.intro{padding:24px;background:var(--card-2);border-top:1px solid var(--line)}
@media (min-width:760px){.split{grid-template-columns:5fr 6fr}.intro{order:-1;border-top:0;border-right:1px solid var(--line);padding:36px 32px}
.signin{padding:36px 40px}}
.eyebrow{letter-spacing:.02em;font-size:.8rem;font-weight:700;color:var(--accent);margin:0 0 6px}
.intro h2{font-size:1.3rem;line-height:1.25;margin:0 0 18px;color:var(--ink)}
.how{list-style:none;margin:0 0 18px;padding:0;display:grid;gap:14px}
.how li{display:flex;gap:12px;align-items:flex-start}
.how .n{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--accent);
color:var(--accent-ink);font-weight:700;font-size:.85rem}
.how strong{display:block;color:var(--ink)}.how small{display:block;color:var(--muted);font-size:.85rem;line-height:1.4}
.signin h1{font-size:1.5rem}
.signin .lead{margin-bottom:20px}
.signin button,.signin .button{width:100%;text-align:center;padding:12px 16px;margin-left:0}
.stack{display:grid;gap:10px;margin:0 0 4px}
.gbtn,.gbtn:hover{display:flex;align-items:center;justify-content:center;gap:12px;background:#fff;color:#1f1f1f;
border:1px solid #747775;border-radius:10px;font-weight:600;text-decoration:none;padding:11px 16px}
.gbtn:hover{background:#f2f6fb;border-color:#5f6368}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .gbtn{background:#131314;color:#e3e3e3;border-color:#8e918f}
:root:not([data-theme="light"]) .gbtn:hover{background:#202124}}
:root[data-theme="dark"] .gbtn{background:#131314;color:#e3e3e3;border-color:#8e918f}
:root[data-theme="dark"] .gbtn:hover{background:#202124}
.gbtn svg{flex:none}
.pk{display:flex;align-items:center;justify-content:center;gap:10px}
.or{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:.85rem;margin:18px 0 14px}
.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--line)}
.fine{font-size:.8rem;margin:18px 0 0}
</style>`;

/** Google's "G" mark, as Google's sign-in branding guidelines show it on the button. */
const GOOGLE_G = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
</svg>`;

/** A key, for the passkey button. Decorative. */
const KEY_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2m-4 4 3 3m-6-0 2 2"/></svg>`;

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

const METHOD_NAMES: Record<IdentityMethod, string> = { google: "Google", email: "Email code", phone: "SMS code" };

/** How someone signs in, as chips. */
const methodChips = (methods: readonly IdentityMethod[], passkeys = 0) => {
  const chips = methods.map((m) => `<li class="chip">${escapeHtml(METHOD_NAMES[m] ?? m)}</li>`);
  if (passkeys) chips.push(`<li class="chip">Passkey${passkeys > 1 ? ` ×${passkeys}` : ""}</li>`);
  return chips.length ? `<ul class="chips" aria-label="Sign-in methods">${chips.join("")}</ul>` : "";
};

/** App names for client ids; an id no longer configured is shown as itself. */
const appChips = (ids: readonly string[], apps: readonly AppLink[]) =>
  ids.length
    ? `<ul class="chips">${ids
        .map((id) => `<li class="chip">${escapeHtml(apps.find((a) => a.id === id)?.name ?? id)}</li>`)
        .join("")}</ul>`
    : `<span class="small">Just an account</span>`;

/** "a", "a or b", "a, b or c". */
const listOr = (items: string[]) =>
  items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;

export interface LoginPageOptions {
  csrf: string;
  email: boolean;
  sms: boolean;
  passkey: boolean;
  google?: boolean;
  error?: string;
  /** What was typed, shown again after an error. */
  value?: string;
}

export function loginPage(o: LoginPageOptions): string {
  const quick = [
    o.google
      ? `<a class="gbtn" href="/login/google" data-testid="google-sign-in">${GOOGLE_G}<span>Continue with Google</span></a>`
      : "",
    o.passkey
      ? `<button type="button" class="secondary pk" data-passkey="login" data-csrf="${escapeHtml(o.csrf)}" hidden>${KEY_ICON}<span>Sign in with a passkey</span></button>`
      : "",
  ].join("");
  const quickBlock = quick
    ? `<div class="stack">${quick}</div>${o.passkey ? '<p class="small" data-passkey-status role="status"></p>' : ""}`
    : "";
  const email = o.email
    ? `<form method="post" action="/login/start">
${csrfField(o.csrf)}<input type="hidden" name="via" value="email">
<label for="email">Email address</label>
<input id="email" name="identifier" type="email" autocomplete="email" required maxlength="254"
 placeholder="you@example.com" value="${escapeHtml(o.value && o.value.includes("@") ? o.value : "")}">
<button type="submit">Email me a sign-in code</button>
</form>`
    : "";
  const smsForm = `<form method="post" action="/login/start">
${csrfField(o.csrf)}<input type="hidden" name="via" value="sms">
<label for="phone">Mobile number</label>
<input id="phone" name="identifier" type="tel" inputmode="tel" autocomplete="tel" required maxlength="32"
 placeholder="+32 470 12 34 56" value="${escapeHtml(o.value && !o.value.includes("@") ? o.value : "")}">
<button type="submit">Text me a code</button>
</form>`;
  // SMS is the fallback: tucked away under the email form, unless it is the only code method.
  const sms = !o.sms
    ? ""
    : o.email
      ? `<details class="more"${o.value && !o.value.includes("@") ? " open" : ""}><summary>Use a mobile number instead</summary>${smsForm}</details>`
      : smsForm;
  const codes = email || sms;
  const divider = quick && codes ? `<div class="or">or get a one-time code</div>` : "";
  const ways = [
    o.google ? "Google" : "",
    o.passkey ? "a passkey" : "",
    o.email ? "a code by email" : "",
    o.sms ? "a code by SMS" : "",
  ].filter(Boolean);
  const how = `<section class="intro" aria-labelledby="how">
<p class="eyebrow">Your ASafariM account</p>
<h2 id="how">One sign-in for every ASafariM app</h2>
<ol class="how">
<li><span class="n">1</span><div><strong>Sign in</strong><small>With ${escapeHtml(listOr(ways))}. The first time creates your account.</small></div></li>
<li><span class="n">2</span><div><strong>Ask for access</strong><small>Pick the apps you need and tell the admin why.</small></div></li>
<li><span class="n">3</span><div><strong>An admin approves</strong><small>You get an email, and your apps open with this same sign-in.</small></div></li>
</ol>
<p class="small">Signing in only proves who you are. No app opens until an administrator gives you access.</p>
</section>`;
  return page(
    "Sign in",
    `<div class="split"><section class="signin" aria-labelledby="signin">
<h1 id="signin">Sign in</h1>
<p class="lead">Welcome to ASafariM. New here? Signing in creates your account.</p>
${err(o.error)}${quickBlock}${divider}${email}${sms}
<p class="fine">By continuing you accept the <a href="https://asafarim.site/terms">terms</a> and the
<a href="https://asafarim.site/privacy">privacy notice</a>.</p>
</section>${how}</div>`,
    `${EXTRA_STYLE}${LOGIN_STYLE}${o.passkey ? '<script src="/static/passkey.js" defer></script>' : ""}`,
  );
}

export function codePage(opts: { csrf: string; masked: string; via: "email" | "sms"; error?: string }): string {
  const where = opts.via === "email" ? "this address" : "this number";
  const what = opts.via === "email" ? "an email" : "an SMS";
  return page(
    "Enter your code",
    `<h1>${opts.via === "email" ? "Check your email" : "Check your phone"}</h1>
<p>If ${where} can sign in, ${what} with a 6-digit code is on its way to <strong>${escapeHtml(opts.masked)}</strong>. It expires in 5 minutes.</p>
${err(opts.error)}
<form method="post" action="/login/verify">
${csrfField(opts.csrf)}
<label for="code">Sign-in code</label>
<input id="code" name="code" class="code" type="text" inputmode="numeric" autocomplete="one-time-code"
 pattern="[0-9]{6}" maxlength="6" required autofocus>
<button type="submit" style="width:100%">Verify and sign in</button>
</form>
<div class="row" style="margin-top:14px">
<form class="inline" method="post" action="/login/resend">${csrfField(opts.csrf)}<button class="secondary" type="submit" style="margin-left:0">Send a new code</button></form>
<a class="button secondary" href="/login/restart">Use another way</a>
</div>
<p class="small" style="margin-top:14px">No email? Check your spam folder. Codes come from ASafariM and are never asked for by anyone.</p>`,
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
  return `<h2>Where to next</h2><ul class="apps two">${tiles}</ul>${note}<h3>More from ASafariM</h3><ul class="apps two">${more}</ul>`;
}

/** The request form: which apps, and a note. Already-requested apps are shown checked and kept. */
function requestForm(opts: {
  csrf: string;
  apps: readonly AppLink[];
  pending: PendingRequest | null;
  submit: string;
}): string {
  const asked = new Set(opts.pending?.apps ?? []);
  const picks = opts.apps.length
    ? `<fieldset class="pick"><legend>Which apps do you need?</legend>${opts.apps
        .map(
          (a) =>
            `<label><input type="checkbox" name="app" value="${escapeHtml(a.id)}"${asked.has(a.id) ? " checked" : ""}><span><strong>${escapeHtml(a.name)}</strong>${
              a.description ? `<small>${escapeHtml(a.description)}</small>` : ""
            }</span></label>`,
        )
        .join("")}</fieldset>`
    : "";
  return `<form method="post" action="/login/request">${csrfField(opts.csrf)}${picks}
<label for="note">Anything the admin should know? <span class="small" style="font-weight:400">(optional)</span></label>
<textarea id="note" name="note" maxlength="${NOTE_MAX}" placeholder="For example: I'm on the IGS-Pharma team and need Docs.">${escapeHtml(opts.pending?.note ?? "")}</textarea>
<button type="submit">${escapeHtml(opts.submit)}</button></form>`;
}

/** Where a pending request stands, for its owner. */
function pendingStatus(pending: PendingRequest, apps: readonly AppLink[]): string {
  return `<div class="status" role="status"><p><span class="pill wait">Waiting for an admin</span> <span class="small">sent ${when(pending.createdAt)}</span></p>
<p class="small">Apps: </p>${appChips(pending.apps, apps)}${pending.note ? `<p class="note" style="margin-top:8px">${escapeHtml(pending.note)}</p>` : ""}</div>`;
}

export function accountPage(opts: {
  csrf: string;
  /** The apps that sign in here and have a name in the client config. */
  apps: readonly AppLink[];
  /** The principal id: the `sub` every app sees, and what an admin grants an app's role to. */
  accountId: string;
  label: string | null;
  initials?: string;
  connected: boolean;
  isAdmin: boolean;
  /** How this account signs in (besides passkeys). */
  methods?: readonly IdentityMethod[];
  /** The open access request, if any. */
  pending?: PendingRequest | null;
  /** Linked in the header for an admin. */
  adminConsoleUrl?: string;
  passkeys: { credentialId: string; name: string; createdAt: Date; lastUsedAt: Date | null }[];
  notice?: string;
}): string {
  const csrf = csrfField(opts.csrf);
  const pending = opts.pending ?? null;
  const list = opts.passkeys.length
    ? // A list, not a table: the account card is too narrow for four columns at any screen width.
      `<ul class="keys">${opts.passkeys
        .map(
          (k) =>
            `<li class="key"><div><strong>${escapeHtml(k.name)}</strong><small>Added ${when(k.createdAt)}</small><small>Last used ${when(k.lastUsedAt)}</small></div><form class="inline" method="post" action="/account/passkeys/remove">${csrf}<input type="hidden" name="id" value="${escapeHtml(k.credentialId)}"><button class="secondary" type="submit">Remove</button></form></li>`,
        )
        .join("")}</ul>`
    : "<p>No passkeys yet.</p>";
  const state = opts.connected
    ? '<span class="pill ok">Connected</span>'
    : pending
      ? '<span class="pill wait">Waiting for approval</span>'
      : '<span class="pill off">Not connected yet</span>';
  const access = opts.connected
    ? pending
      ? `<h2>Access request</h2>${pendingStatus(pending, opts.apps)}<details class="more"><summary>Add apps or change your note</summary>${requestForm({ csrf: opts.csrf, apps: opts.apps, pending, submit: "Update request" })}</details>`
      : opts.apps.length
        ? `<details class="more"><summary>Need another app? Ask for access</summary>${requestForm({ csrf: opts.csrf, apps: opts.apps, pending: null, submit: "Send request" })}</details>`
        : ""
    : `<h2>Access</h2>${
        pending
          ? pendingStatus(pending, opts.apps)
          : "<p>Your account isn't connected yet. Ask an administrator for access to start using ASafariM apps.</p>"
      }<p><a class="button" href="/login">${pending ? "See or change your request" : "Ask for access"}</a></p>`;
  return page(
    "Your account",
    `<h1>Your account</h1>
${opts.notice ? `<p class="notice" role="status">${escapeHtml(opts.notice)}</p>` : ""}
<div class="who"><span class="avatar" aria-hidden="true">${escapeHtml(opts.initials ?? "?")}</span><div><strong>${escapeHtml(opts.label ?? "—")}</strong>${state}</div></div>
<p class="small">Account id: <code data-account-id>${escapeHtml(opts.accountId)}</code>. An admin uses it to give you access to an app.</p>
${access}
${nextSteps(opts.apps, opts.connected)}
<h2>How you sign in</h2>
${methodChips(opts.methods ?? [], opts.passkeys.length)}
<h3>Passkeys</h3>
<p class="small">A passkey lets you sign in with your fingerprint, face or device PIN instead of a code.</p>
${list}
<p><button type="button" data-passkey="register" data-csrf="${escapeHtml(opts.csrf)}" hidden>Add a passkey</button></p>
<p class="small" data-passkey-status role="status"></p>
<form method="post" action="/logout">${csrf}<button class="secondary" type="submit" style="margin-left:0">Sign out</button></form>`,
    {
      head: `${EXTRA_STYLE}<style>main>.card{max-width:720px}</style><script src="/static/passkey.js" defer></script>`,
      nav: signedInNav("account", opts.isAdmin, opts.adminConsoleUrl),
    },
  );
}

/** The four steps from a first sign-in to an open app; `at` is the current one (1-based). */
const progress = (at: number) =>
  `<ol class="steps" aria-label="Your progress">${["Signed in", "Ask for access", "Admin review", "Open your apps"]
    .map(
      (s, i) =>
        `<li class="${i + 1 < at ? "done" : i + 1 === at ? "now" : ""}"${i + 1 === at ? ' aria-current="step"' : ""}>${s}</li>`,
    )
    .join("")}</ol>`;

export function notConnectedPage(opts: {
  csrf: string;
  pending: boolean | PendingRequest | null;
  justRequested?: boolean;
  /** The apps someone can ask for. */
  apps?: readonly AppLink[];
  label?: string | null;
  methods?: readonly IdentityMethod[];
  error?: string;
}): string {
  const apps = opts.apps ?? [];
  const pending = typeof opts.pending === "object" ? opts.pending : null;
  const isPending = Boolean(opts.pending);
  const who = opts.label
    ? `<p>Signed in as <strong>${escapeHtml(opts.label)}</strong></p>${methodChips(opts.methods ?? [])}`
    : "";
  const body = isPending
    ? `<h1>Request pending</h1>${progress(3)}
<p class="notice" role="status">${opts.justRequested ? "Your request has been sent." : "You've already asked for access."} An administrator will review it, and you'll get an email when it's decided. Then sign in again.</p>
${pending ? pendingStatus(pending, apps) : ""}
${pending ? `<details class="more"><summary>Add apps or change your note</summary>${requestForm({ csrf: opts.csrf, apps, pending, submit: "Update request" })}</details>` : ""}`
    : `<h1>Ask for access</h1>${progress(2)}
<p>You're signed in, but your account isn't connected to ASafariM yet. Tell an administrator what you need: they'll review it and you'll get an email.</p>
${err(opts.error)}${requestForm({ csrf: opts.csrf, apps, pending: null, submit: "Send request" })}`;
  return page(
    isPending ? "Request pending" : "Ask for access",
    `${body}
<div style="margin-top:20px;border-top:1px solid var(--line);padding-top:14px">${who}
<form method="post" action="/logout">${csrfField(opts.csrf)}<button class="secondary" type="submit" style="margin-left:0">Sign out</button></form></div>`,
    { head: `${EXTRA_STYLE}<style>main>.card{max-width:560px}</style>` },
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
  /** Names for the client ids requests carry. */
  apps?: readonly AppLink[];
  /** Linked in the header, and after an approval (app roles are granted there). */
  adminConsoleUrl?: string;
  notice?: string;
  /** After an approval: point at the Admin console, where app roles are granted. */
  grantHint?: boolean;
  error?: string;
}): string {
  const csrf = csrfField(opts.csrf);
  const apps = opts.apps ?? [];
  const requests = opts.requests.length
    ? table(
        ["Who", "Apps", "Note", "Requested", ""],
        opts.requests
          .map(
            (r) =>
              `<tr>${cell(
                "Who",
                `<strong>${labelCell(r.label)}</strong>${r.connected ? ' <span class="pill ok">connected</span>' : ""}<div style="margin-top:4px">${methodChips(r.methods)}</div>`,
              )}${cell("Apps", appChips(r.apps, apps))}${cell(
                "Note",
                r.note ? `<span class="note">${escapeHtml(r.note)}</span>` : '<span class="small">—</span>',
              )}${cell("Requested", when(r.createdAt))}${cell(
                "",
                `<div class="row">
<form class="inline" method="post" action="/admin/requests/${escapeHtml(r.id)}/approve">${csrf}<button type="submit">Approve</button></form>
<form class="inline" method="post" action="/admin/requests/${escapeHtml(r.id)}/reject">${csrf}<button class="secondary" type="submit" style="margin-left:0">Reject</button></form>
</div>`,
              )}</tr>`,
          )
          .join(""),
      )
    : "<p>No pending requests. You're all caught up.</p>";

  const connections = opts.connections.length
    ? table(
        ["Who", "Status", "Granted", "Last sign-in", ""],
        opts.connections
          .map((c) => {
            const self = c.principalId === opts.me;
            const action =
              c.status === "active" && !self
                ? `<form class="inline" method="post" action="/admin/connections/${escapeHtml(c.principalId)}/revoke">${csrf}<button class="danger" type="submit">Revoke</button></form>`
                : c.status === "revoked"
                  ? `<form class="inline" method="post" action="/admin/connections/${escapeHtml(c.principalId)}/reconnect">${csrf}<button class="secondary" type="submit" style="margin-left:0">Reconnect</button></form>`
                  : self
                    ? `<span class="small">you</span>`
                    : "";
            return `<tr>${cell("Who", `${labelCell(c.label)}${c.isAdmin ? ' <span class="small">(admin)</span>' : ""}`)}${cell(
              "Status",
              `<span class="pill ${c.status === "active" ? "ok" : "off"}">${escapeHtml(c.status)}</span>${c.revokedAt ? ` <span class="small">${when(c.revokedAt)}</span>` : ""}`,
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
                    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`)
                    .join(" "),
                )}</span>`,
              )}</tr>`,
          )
          .join(""),
      )
    : "<p>Nothing yet.</p>";

  const active = opts.connections.filter((c) => c.status === "active").length;
  const stats = `<div class="stats"><div class="stat"><b>${opts.requests.length}</b><span>pending</span></div>
<div class="stat"><b>${active}</b><span>connected</span></div>
<div class="stat"><b>${opts.connections.length - active}</b><span>revoked</span></div></div>`;
  const hint =
    opts.grantHint && opts.adminConsoleUrl
      ? ` <a href="${escapeHtml(opts.adminConsoleUrl)}">Give them roles for their apps in the Admin console</a>.`
      : "";

  return page(
    "Connections",
    `<h1>Connections</h1>
<p class="small">Who may sign in to ASafariM apps. Approving connects an account; what each person may do inside an app is a role you grant in the Admin console.</p>
${stats}
${opts.notice ? `<p class="notice" role="status">${escapeHtml(opts.notice)}${hint}</p>` : ""}${err(opts.error)}
<h2>Access requests</h2>${requests}
<h2>Connect someone</h2>
<form method="post" action="/admin/connections" class="row">${csrf}
<input name="identifier" type="text" required maxlength="254" placeholder="email or +32 470 12 34 56" style="max-width:300px;margin:0" aria-label="Email address or mobile number">
<button type="submit">Connect</button></form>
<h2>Connections</h2>${connections}
<h2>Recent activity</h2>${audit}
<form method="post" action="/logout">${csrf}<button class="secondary" type="submit" style="margin-left:0">Sign out</button></form>`,
    {
      head: `${EXTRA_STYLE}<style>main>.card{max-width:1040px}</style>`,
      nav: signedInNav("admin", true, opts.adminConsoleUrl),
    },
  );
}
