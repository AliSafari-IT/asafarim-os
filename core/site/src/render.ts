/**
 * Renders the asafarim.site landing page from the progress file. Pure: progress in, HTML out.
 *
 * The page is static HTML, one stylesheet and one small script of this origin's own (session.js, which
 * asks identity who is signed in and swaps "Sign in" for their avatar): no inline scripts or styles, no
 * web fonts, no third-party assets. That is what lets the edge serve it under a CSP with
 * `script-src 'self'` and `connect-src` identity only (sites/asafarim-os.caddy).
 */
import { pullRequestUrl, type Progress } from "./progress.ts";

export interface ImageSize {
  width: number;
  height: number;
}

export interface RenderOptions {
  /** Pixel size of each screenshot by file name, so the browser reserves the space (no layout shift). */
  imageSizes: ReadonlyMap<string, ImageSize>;
}

export const SITE_URL = "https://asafarim.site/";
export const TITLE = "ASafariM OS: the operating system apps plug into";
export const DESCRIPTION =
  "ASafariM OS is a base platform that apps plug into. Every app gets sign-in, permissions, routing, events, lifecycle and monitoring from the OS instead of building them itself.";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape text for HTML content and double-quoted attributes. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-03" → "3 Oct 2026", the same in every locale and time zone. */
export function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${MONTHS[(month ?? 1) - 1]} ${year}`;
}

const anchor = (href: string, label: string, extra = "") =>
  `<a href="${escapeHtml(href)}"${extra}>${escapeHtml(label)}</a>`;

/**
 * The top bar's links to the OS's live apps. Docs asks a signed-out visitor to sign in first; "Sign in" opens
 * id.asafarim.site's own sign-in page (email code or passkey), which also offers "Request connection" to someone
 * who has no access yet.
 */
/**
 * Identity's origin: session.js asks its /whoami who is signed in (credentialed, CORS for this site only).
 * session.js has the same constant (a static file); the render test keeps the two equal.
 */
export const IDENTITY_ORIGIN = "https://id.asafarim.site";

export const APP_LINKS = {
  docs: { label: "Docs", href: "https://docs.asafarim.site/" },
  signIn: { label: "Sign in", href: "https://id.asafarim.site/login" },
} as const;

/** The brand mark: the OS core with an app orbiting it (it turns slowly; still with "reduce motion"). */
const BRAND_MARK = `<svg class="mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false">
        <rect class="mark-core" x="8" y="8" width="16" height="16" rx="5" />
        <g class="mark-orbit"><circle cx="16" cy="2.5" r="2.5" /></g>
        <g class="mark-orbit mark-orbit-slow"><circle cx="29.5" cy="16" r="1.75" /></g>
      </svg>`;

/**
 * The hero's picture: apps orbiting the OS core on two rings, the rings' dashes drifting. Decorative
 * (aria-hidden), drawn in the theme's colours, and still with "reduce motion".
 */
const HERO_ART = `
      <svg class="hero-art" viewBox="0 0 240 240" aria-hidden="true" focusable="false">
        <circle class="ring" cx="120" cy="120" r="104" />
        <circle class="ring ring-inner" cx="120" cy="120" r="70" />
        <g class="orbit orbit-outer">
          <circle class="app" cx="120" cy="16" r="11" />
          <circle class="app app-soft" cx="210" cy="172" r="8" />
          <circle class="app app-soft" cx="30" cy="172" r="6" />
        </g>
        <g class="orbit orbit-inner">
          <circle class="app" cx="190" cy="120" r="7" />
          <circle class="app app-soft" cx="50" cy="120" r="9" />
        </g>
        <rect class="core" x="84" y="84" width="72" height="72" rx="20" />
        <text class="core-text" x="120" y="129" text-anchor="middle">OS</text>
      </svg>`;

function renderTopbar(): string {
  return `
    <nav class="topbar" aria-label="Main">
      <a class="brand" href="./">${BRAND_MARK}<span class="brand-name">ASafariM <span>OS</span></span></a>
      <ul>
        <li>${anchor(APP_LINKS.docs.href, APP_LINKS.docs.label)}</li>
        <li id="account">${anchor(APP_LINKS.signIn.href, APP_LINKS.signIn.label, ' class="btn btn-small"')}</li>
      </ul>
    </nav>`;
}

function renderAccess(): string {
  return `
      <p class="access" id="access">
        Have access? ${anchor(APP_LINKS.signIn.href, "Sign in")}, then open ${anchor(APP_LINKS.docs.href, "the docs")}.
        No access yet? Sign in with your email and choose <em>Request connection</em>: an admin approves it.
      </p>`;
}

const BENEFITS = ["Sign-in", "Permissions", "Routing", "Events", "Lifecycle", "Monitoring"];

function renderShipped(progress: Progress): string {
  const items = progress.shipped
    .map((m) => {
      const prs = m.prs.map((n) => anchor(pullRequestUrl(progress.repo, n), `#${n}`)).join(", ");
      return `
        <li class="milestone">
          <div class="milestone-head">
            <span class="tag">${escapeHtml(m.id)}</span>
            <h3>${escapeHtml(m.title)}</h3>
            <time datetime="${escapeHtml(m.date)}">${escapeHtml(formatDate(m.date))}</time>
          </div>
          <p>${escapeHtml(m.summary)}</p>
          <p class="prs">Merged pull requests: ${prs}</p>
        </li>`;
    })
    .join("");
  return `
      <section id="shipped" aria-labelledby="shipped-title">
        <h2 id="shipped-title">Shipped</h2>
        <p class="section-lead">What is built and merged so far, phase by phase.</p>
        <ol class="milestones">${items}
        </ol>
      </section>`;
}

function renderScreenshots(progress: Progress, sizes: RenderOptions["imageSizes"]): string {
  const figures = progress.screenshots
    .map((s) => {
      const size = sizes.get(s.file);
      if (!size) throw new Error(`render: no size for screenshots/${s.file} (is the file there?)`);
      return `
          <figure>
            <img src="screenshots/${escapeHtml(s.file)}" alt="${escapeHtml(s.alt)}" width="${size.width}" height="${size.height}" loading="lazy" decoding="async" />
            <figcaption><strong>${escapeHtml(s.title)}.</strong> ${escapeHtml(s.caption)}</figcaption>
          </figure>`;
    })
    .join("");
  return `
      <section id="screenshots" aria-labelledby="screenshots-title">
        <h2 id="screenshots-title">Screenshots</h2>
        <p class="section-lead">Taken by Playwright from the end-to-end test environment, not drawn by hand.</p>
        <div class="gallery">${figures}
        </div>
      </section>`;
}

function renderRoadmap(progress: Progress): string {
  const items = progress.roadmap
    .map(
      (r) => `
          <li>
            <span class="tag">${escapeHtml(r.id)}</span>
            <div><h3>${escapeHtml(r.title)}</h3><p>${escapeHtml(r.summary)}</p></div>
          </li>`,
    )
    .join("");
  return `
      <section id="roadmap" aria-labelledby="roadmap-title">
        <h2 id="roadmap-title">Roadmap</h2>
        <ol class="roadmap">${items}
        </ol>
      </section>`;
}

/** The whole page. */
export function renderPage(progress: Progress, options: RenderOptions): string {
  const links = progress.links.map((l) => anchor(l.href, l.label, ' class="btn"')).join("\n          ");
  const benefits = BENEFITS.map((b) => `<li>${escapeHtml(b)}</li>`).join("");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(TITLE)}</title>
    <meta name="description" content="${escapeHtml(DESCRIPTION)}" />
    <meta name="color-scheme" content="light dark" />
    <link rel="canonical" href="${SITE_URL}" />
    <link rel="icon" href="favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="styles.css" />
    <script src="session.js" defer></script>
  </head>
  <body>${renderTopbar()}
    <header class="hero">${HERO_ART}
      <span class="badge">In development · updated ${escapeHtml(formatDate(progress.updated))}</span>
      <h1>ASafariM <span>OS</span></h1>
      <p class="lead">
        A base platform: an operating system that apps plug into. Every app gets the OS's advantages
        without building them itself.
      </p>
      <ul class="benefits" aria-label="What every app gets from the OS">${benefits}</ul>
      <p class="note">
        ASafariM OS is a new system with its own apps. It is not a migration of the asafarim.com
        platform, which keeps running as it is.
      </p>
      <nav class="actions" aria-label="Links">
          ${links}
      </nav>${renderAccess()}
    </header>
    <main>${renderShipped(progress)}${renderScreenshots(progress, options.imageSizes)}${renderRoadmap(progress)}
    </main>
    <footer>
      <p>ASafariM OS · ${anchor(progress.repo, "Source on GitHub")} · ${anchor("https://asafarim.com/", "asafarim.com")}</p>
    </footer>
  </body>
</html>
`;
}
