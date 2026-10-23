/**
 * The service's own HTML: the shared layout every page uses (header, footer, favicon), the error
 * page (oidc-provider's renderError and every hand-off failure), the logout confirmation and the
 * logged-out page. Small, self-contained (no external fonts; one script of its own, the theme's), in
 * @asafarim/theme's tokens, like asafarim.site and every app, so the hosts look like one product.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
/**
 * @asafarim/theme, shared with asafarim.site and every app: its tokens and top bar (theme.css, inlined into
 * the page's style), its light/dark script (theme.js, served at /static/theme.js and run in <head>, so a
 * remembered choice applies before paint) and the toggle's markup. Read once, at startup.
 */
const themeFile = (name: string) => readFileSync(fileURLToPath(import.meta.resolve(`@asafarim/theme/${name}`)), "utf8");
// Comments stripped: every page carries it inline.
const THEME_CSS = themeFile("theme.css").replace(/\/\*[\s\S]*?\*\//g, "");
export const THEME_JS = themeFile("theme.js");
const THEME_TOGGLE = themeFile("toggle.html").trim();

const STYLE = `
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;flex-direction:column;color:var(--ink);
background:var(--bg);
font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}a:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.topbar,.foot{width:100%;max-width:60rem;margin:0 auto;padding:14px 16px;display:flex;align-items:center;
justify-content:space-between;gap:12px;flex-wrap:wrap}
.topbar{padding-top:10px;padding-bottom:10px}.tools{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.brand{display:inline-flex;align-items:center;gap:.55rem;color:var(--ink);text-decoration:none;font-weight:700;letter-spacing:-.01em}
.brand span span{color:var(--accent)}.mark{flex:none}.mark rect{fill:var(--brand-b)}.mark circle{fill:var(--brand-a)}.mark .soft{opacity:.6}
.nav{display:flex;gap:16px;margin:0;padding:0;list-style:none}.nav a{font-weight:600;text-decoration:none}
.nav a[aria-current]{color:var(--ink)}
main{flex:1;width:100%;display:flex;justify-content:center;align-items:flex-start;padding:32px 16px}
.card{max-width:440px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;
box-shadow:var(--shadow)}
.foot{border-top:1px solid var(--line);color:var(--muted);font-size:.85rem}.foot p{margin:0}
h1{font-size:1.35rem;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}
button,.button{display:inline-block;border:0;border-radius:10px;background:var(--accent);color:var(--accent-ink);font:inherit;
font-weight:600;padding:10px 16px;cursor:pointer;text-decoration:none}
button:hover,.button:hover{background:var(--accent-hover)}
.secondary,.secondary:hover{background:transparent;color:var(--muted);border:1px solid var(--line);margin-left:8px}
.secondary:hover{border-color:var(--accent);color:var(--ink)}
code{font-size:.85em;color:var(--muted)}`;

/** The brand mark of asafarim.site (core/site), still: the OS core with two apps around it. Decorative. */
const BRAND_MARK = `<svg class="mark" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true" focusable="false">
<rect x="8" y="8" width="16" height="16" rx="5"/><circle cx="16" cy="2.5" r="2.5"/><circle class="soft" cx="29.5" cy="16" r="1.75"/></svg>`;

/** The favicon, the same as asafarim.site's (core/site/public/favicon.svg). Served at /favicon.svg. */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#9f4a07"/><text x="16" y="22" font-family="system-ui,sans-serif" font-size="15" font-weight="700" text-anchor="middle" fill="#fdfaf3">OS</text></svg>`;

const DEFAULT_HOME_URL = "https://asafarim.site/";
let homeUrl = DEFAULT_HOME_URL;

/**
 * Where the header's brand and "Home" link go: the OS home page (IDENTITY_HOME_URL). Set once at
 * startup; the hub login method has no home URL of its own and keeps asafarim.site.
 */
export function setHomeUrl(url: string): void {
  homeUrl = url;
}

export function homeHref(): string {
  return homeUrl;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A link in the header. `current` marks the page you're on. */
export interface NavLink {
  href: string;
  label: string;
  current?: boolean;
}

export interface PageOptions {
  /** Extra, already-safe markup for the document head (styles, the passkey script, a meta refresh). */
  head?: string;
  /** The header's links. Default: Home only. */
  nav?: NavLink[];
  /** The light/dark toggle and its script. Default true; false for a page whose CSP allows no script. */
  themeToggle?: boolean;
}

/** The header's "Home" link, first on every page. */
export const homeLink = (): NavLink => ({ href: homeUrl, label: "Home" });

/**
 * Every page: a header with the brand (back to the OS home) and its links, the page's card, and a
 * footer, so no page here is a dead end. `head` may also be passed as a string (the old signature).
 */
export function page(title: string, body: string, options: PageOptions | string = {}): string {
  const {
    head = "",
    nav = [homeLink()],
    themeToggle = true,
  } = typeof options === "string" ? { head: options } : options;
  const home = escapeHtml(homeUrl);
  const links = nav
    .map(
      (l) =>
        `<li><a href="${escapeHtml(l.href)}"${l.current ? ' aria-current="page"' : ""}>${escapeHtml(l.label)}</a></li>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
${themeToggle ? '<script src="/static/theme.js"></script>' : ""}${head}<title>${escapeHtml(title)} · ASafariM</title><style>${THEME_CSS}${STYLE}</style></head>
<body><header class="os-topbar"><div class="topbar"><a class="brand" href="${home}">${BRAND_MARK}<span>ASafariM <span>OS</span></span></a>
<div class="tools"><nav aria-label="Main"><ul class="nav">${links}</ul></nav>${themeToggle ? THEME_TOGGLE : ""}</div></div></header>
<main><div class="card">${body}</div></main>
<footer class="foot"><p>ASafariM OS · sign-in and accounts for ASafariM apps</p><p><a href="${home}">${escapeHtml(new URL(homeUrl).host)}</a></p></footer>
</body></html>`;
}

/** A sign-in failure. Shows a code, never token contents or account data. */
export function errorPage(opts: { title?: string; message: string; code?: string }): string {
  const code = opts.code ? `<p><code>${escapeHtml(opts.code)}</code></p>` : "";
  return page(
    opts.title ?? "Sign-in didn't complete",
    `<h1>${escapeHtml(opts.title ?? "Sign-in didn't complete")}</h1><p>${escapeHtml(opts.message)}</p>${code}
<p>Go back to the app and start signing in again.</p>
<p><a class="button" href="${escapeHtml(homeUrl)}">Go to ASafariM OS home</a></p>`,
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
  return page(
    "Signed out",
    `<h1>You're signed out</h1><p>You can close this tab, or carry on to the ASafariM OS home page.</p>
<p><a class="button" href="${escapeHtml(homeUrl)}">Go to ASafariM OS home</a></p>`,
  );
}

/**
 * The answer to Hub's assertion POST (asafarim-os#40). It must NOT redirect: Hub's assertion page sends
 * `form-action <issuer>`, and Chromium applies that to EVERY redirect in the chain a form submission
 * starts, so a 303 chain that ends on the client's origin is blocked and sign-in dead-ends (with the login
 * already consumed). A navigation THIS page starts is a new navigation, so Hub's `form-action` no longer
 * applies. No script: a meta refresh, plus a visible link as the fallback.
 *
 * The `uid` is already restricted to `[\w-]+` by the route, and is escaped anyway.
 */
export function continuePage(uid: string): string {
  const next = `/interaction/${escapeHtml(uid)}/complete`;
  return page(
    "Signing you in",
    `<h1>Signing you in…</h1><p>Taking you back to the app.</p>
<p><a class="button" href="${next}">Continue</a></p>`,
    { head: `<meta http-equiv="refresh" content="0;url=${next}">`, themeToggle: false },
  );
}

/** This page runs no script and starts no form: nothing but its own navigation, and nobody may frame it. */
export const CONTINUE_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
