/**
 * Renders the asafarim.site landing page from the progress file. Pure: progress in, HTML out.
 *
 * The page is static HTML, one stylesheet and one small script of this origin's own (session.js, which
 * asks identity who is signed in and swaps "Sign in" for their avatar): no inline scripts or styles, no
 * web fonts, no third-party assets. That is what lets the edge serve it under a CSP with
 * `script-src 'self'` and `connect-src` identity only (sites/asafarim-os.caddy).
 */
import { LEGAL_DOCS, LEGAL_UPDATED, type LegalBlock, type LegalDoc } from "./legal.ts";
import { type App, pullRequestUrl, type Progress, type Surface, type SurfaceStatus } from "./progress.ts";

export interface ImageSize {
  width: number;
  height: number;
}

export interface RenderOptions {
  /** Pixel size of each screenshot by file name, so the browser reserves the space (no layout shift). */
  imageSizes: ReadonlyMap<string, ImageSize>;
  /** The light/dark toggle's markup (@asafarim/theme's toggle.html), put in the top bar. Default: none. */
  themeToggle?: string;
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

/** The share preview (1200×630, public/og.png): the top of the page, without its date or sign-in line. */
export const OG_IMAGE = { file: "og.png", width: 1200, height: 630 } as const;

/**
 * Open Graph and Twitter card tags: how a link to the page looks when shared (LinkedIn, WhatsApp, Slack, X).
 * Crawlers fetch the image themselves, so its full URL does not need the page's CSP.
 */
export function shareMeta(title: string, description: string, url: string): string {
  return `
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="ASafariM OS" />
    <meta property="og:locale" content="en_US" />
    <meta property="og:url" content="${escapeHtml(url)}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:image" content="${SITE_URL}${OG_IMAGE.file}" />
    <meta property="og:image:width" content="${OG_IMAGE.width}" />
    <meta property="og:image:height" content="${OG_IMAGE.height}" />
    <meta property="og:image:alt" content="${escapeHtml(TITLE)}" />
    <meta name="twitter:card" content="summary_large_image" />`;
}

/**
 * schema.org JSON-LD for the home page: the organisation and the site. A JSON data block, not a script: the
 * CSP's script-src does not apply to it and browsers never run it. "<" is escaped so no text can close it.
 */
export function structuredData(repo: string): string {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${SITE_URL}#org`,
        name: "ASafariM",
        url: SITE_URL,
        logo: `${SITE_URL}favicon.svg`,
        sameAs: [repo, "https://asafarim.com/"],
      },
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}#website`,
        url: SITE_URL,
        name: "ASafariM OS",
        description: DESCRIPTION,
        inLanguage: "en",
        publisher: { "@id": `${SITE_URL}#org` },
      },
    ],
  };
  return `
    <script type="application/ld+json">${JSON.stringify(graph).replaceAll("<", "\\u003c")}</script>`;
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
 * The top bar's app and product launchers. "Sign in" opens id.asafarim.site's own sign-in page
 * (email code or passkey), which also offers "Request connection" to someone who has no access yet.
 */
/**
 * Identity's origin: session.js asks its /whoami who is signed in (credentialed, CORS for this site only).
 * session.js has the same constant (a static file); the render test keeps the two equal.
 */
export const IDENTITY_ORIGIN = "https://id.asafarim.site";

export const APP_LINKS = {
  breinhap: { label: "Breinhap", href: "https://breinhap.asafarim.site/en/" },
  docs: { label: "Docs", href: "https://docs.asafarim.site/" },
  flow: { label: "Flow", href: "https://flow.asafarim.site/" },
  igs: { label: "IGS-Pharma", href: "https://igs.asafarim.site/en/" },
  signIn: { label: "Sign in", href: "https://id.asafarim.site/login" },
} as const;

/** The brand mark: the OS core with an app orbiting it (it turns slowly; still with "reduce motion"). */
const BRAND_MARK = `<svg class="mark" viewBox="0 0 32 32" width="38" height="38" aria-hidden="true" focusable="false">
        <rect class="mark-core" x="8" y="8" width="16" height="16" rx="5" />
        <g class="mark-spin">
          <g class="mark-orbit"><circle cx="16" cy="2.5" r="2.5" /></g>
          <g class="mark-orbit mark-orbit-slow"><circle cx="29.5" cy="16" r="1.75" /></g>
        </g>
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

function renderTopbar(themeToggle: string, home = "./"): string {
  return `
    <div class="os-topbar">
    <nav class="topbar" aria-label="Main">
      <a class="brand" href="${home}">${BRAND_MARK}<span class="brand-name">ASafariM <span>OS</span></span></a>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="primary-nav" aria-label="Open navigation" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
      </button>
      <ul class="primary-nav" id="primary-nav">
        <li>
          <details class="nav-dropdown">
            <summary>Apps <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m3.5 6 4.5 4 4.5-4" /></svg></summary>
            <div class="nav-panel">
              <div class="nav-panel-heading"><strong>Your workspace</strong><span>Tools connected to ASafariM OS</span></div>
              <div class="nav-card-grid">
                <a class="nav-card" href="${APP_LINKS.docs.href}" aria-label="Docs">
                  <span class="nav-card-icon nav-card-docs" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3.75h8l4 4v12.5H6zM14 3.75v4.5h4M9 12h6M9 15.5h6" /></svg></span>
                  <span class="nav-card-copy"><strong>Docs</strong><small>Guides and your workspace</small></span><span class="nav-card-arrow" aria-hidden="true">↗</span>
                </a>
                <a class="nav-card" href="${APP_LINKS.flow.href}" aria-label="Flow">
                  <span class="nav-card-icon nav-card-flow" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="5" height="5" rx="1" /><rect x="15" y="15" width="5" height="5" rx="1" /><path d="M9 6.5h4a2 2 0 0 1 2 2v4.5M15 13v2" /></svg></span>
                  <span class="nav-card-copy"><strong>Flow</strong><small>Automate work with workflows</small></span><span class="nav-card-arrow" aria-hidden="true">↗</span>
                </a>
              </div>
              <p class="nav-panel-foot">One sign-in. A connected workspace. <a href="${home}#apps">Every app</a></p>
            </div>
          </details>
        </li>
        <li>
          <details class="nav-dropdown">
            <summary>Products <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m3.5 6 4.5 4 4.5-4" /></svg></summary>
            <div class="nav-panel nav-panel-compact">
              <div class="nav-panel-heading"><strong>More from ASafariM</strong><span>Explore our products</span></div>
              <a class="nav-product-link" href="${APP_LINKS.breinhap.href}" aria-label="Breinhap"><strong>Breinhap</strong><span>Short study missions for secondary school</span><span aria-hidden="true">↗</span></a>
              <a class="nav-product-link" href="${APP_LINKS.igs.href}" aria-label="IGS-Pharma"><strong>IGS-Pharma</strong><span>Belgian online pharmacy with a pharmacist</span><span aria-hidden="true">↗</span></a>
              <p class="nav-panel-foot"><a href="${home}#apps-products">Webshop, Android app and status</a></p>
            </div>
          </details>
        </li>
        <li><a class="nav-link" href="#shipped">Platform</a></li>
${themeToggle ? `        <li class="nav-theme">${themeToggle.trim()}</li>\n` : ""}        <li id="account">${anchor(APP_LINKS.signIn.href, APP_LINKS.signIn.label, ' class="btn btn-small"')}</li>
      </ul>
    </nav>
    </div>`;
}

function renderAccess(): string {
  return `
      <p class="access" id="access">
        Have access? ${anchor(APP_LINKS.signIn.href, "Sign in")}, then open ${anchor(APP_LINKS.docs.href, "Docs")} or
        ${anchor(APP_LINKS.flow.href, "Flow")}, if your account has access.
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

const STATUS_LABELS: Record<SurfaceStatus, string> = {
  live: "Live",
  "early-access": "Early access",
  testing: "Testing",
  "in-development": "In development",
  "staff-only": "Staff only",
};

function renderSurface(surface: Surface): string {
  const address = surface.href
    ? anchor(surface.href, surface.address)
    : `<span class="surface-address">${escapeHtml(surface.address)}</span>`;
  return `
              <li class="surface">
                <span class="surface-kind">${escapeHtml(surface.kind)}</span>
                ${address}
                <span class="status status-${surface.status}">${escapeHtml(STATUS_LABELS[surface.status])}</span>
                <p class="surface-note">${escapeHtml(surface.note)}</p>
              </li>`;
}

function renderAppCard(app: App): string {
  return `
          <li class="app-card app-card-${app.group}" id="app-${escapeHtml(app.id)}">
            <h4>${escapeHtml(app.name)}</h4>
            <p class="app-tagline">${escapeHtml(app.tagline)}</p>
            <p class="app-summary">${escapeHtml(app.summary)}</p>
            <ul class="surfaces" aria-label="Where to find ${escapeHtml(app.name)}">${app.surfaces.map(renderSurface).join("")}
            </ul>
          </li>`;
}

/**
 * The apps (asafarim-os#312): the OS's own apps, then the products ASafariM builds on their own domains
 * (IGS-Pharma, Breinhap), each with every place it can be reached and how far that is. Products'
 * pages are linked in English (this page is English).
 */
function renderApps(progress: Progress): string {
  const group = (g: App["group"]) =>
    progress.apps
      .filter((a) => a.group === g)
      .map(renderAppCard)
      .join("");
  return `
      <section id="apps" aria-labelledby="apps-title">
        <h2 id="apps-title">Apps</h2>
        <p class="section-lead">What runs on ASafariM OS, and the products built alongside it: every place you can reach each one, and how far it is.</p>
        <h3 class="apps-group" id="apps-os">Built into the OS</h3>
        <ul class="app-grid" aria-labelledby="apps-os">${group("os")}
        </ul>
        <h3 class="apps-group" id="apps-products">Products built by ASafariM</h3>
        <p class="section-lead">Their own code and domains, with the OS's look; their project pages are served by the OS stack.</p>
        <ul class="app-grid app-grid-products" aria-labelledby="apps-products">${group("product")}
        </ul>
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
    <link rel="canonical" href="${SITE_URL}" />${shareMeta(TITLE, DESCRIPTION, SITE_URL)}${structuredData(progress.repo)}
    <link rel="icon" href="favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="theme.css" />
    <link rel="stylesheet" href="styles.css" />
    <script src="theme.js"></script>
    <script src="session.js" defer></script>
  </head>
  <body>${renderTopbar(options.themeToggle ?? "")}
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
    <main>${renderApps(progress)}${renderShipped(progress)}${renderScreenshots(progress, options.imageSizes)}${renderRoadmap(progress)}
    </main>
${renderFooter(progress.repo)}
  </body>
</html>
`;
}

/** The footer of every page here: the project's links, then the legal pages. */
function renderFooter(repo: string): string {
  const legal = LEGAL_DOCS.map((d) => anchor(`/${d.slug}`, d.label)).join(" · ");
  return `    <footer>
      <p>ASafariM OS · ${anchor(repo, "Source on GitHub")} · ${anchor(APP_LINKS.docs.href, "Docs")} · ${anchor(APP_LINKS.flow.href, "Flow")} · ${anchor(APP_LINKS.breinhap.href, "Breinhap")} · ${anchor(APP_LINKS.igs.href, "IGS-Pharma")} · ${anchor("https://asafarim.com/", "asafarim.com")}</p>
      <p class="legal-links">${legal} · ${anchor("mailto:privacy@asafarim.site", "privacy@asafarim.site")}</p>
    </footer>`;
}

function renderBlock(block: LegalBlock): string {
  if (typeof block === "string") return `<p>${block}</p>`;
  if ("list" in block) return `<ul>${block.list.map((li) => `<li>${li}</li>`).join("")}</ul>`;
  const { caption, head, rows } = block.table;
  // A responsive table (@asafarim/theme): on a phone each row is a card, its cells labelled.
  const body = rows
    .map(
      ([first, ...rest]) =>
        `<tr><th scope="row">${first ?? ""}</th>${rest.map((cell, i) => `<td data-label="${escapeHtml(head[i + 1] ?? "")}">${cell}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<div class="os-table-wrap"><table class="os-table os-table--stack"><caption>${caption}</caption><thead><tr>${head
    .map((h) => `<th scope="col">${escapeHtml(h)}</th>`)
    .join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** A legal page (privacy, cookies, terms), served at /<slug>: the same top bar and footer as the home page. */
export function renderLegalPage(doc: LegalDoc, options: { repo: string; themeToggle?: string }): string {
  const toc = doc.sections.map((s) => `<li>${anchor(`#${s.id}`, s.heading)}</li>`).join("");
  const sections = doc.sections
    .map(
      (s) => `
        <section id="${escapeHtml(s.id)}" aria-labelledby="${escapeHtml(s.id)}-title">
          <h2 id="${escapeHtml(s.id)}-title">${escapeHtml(s.heading)}</h2>
          ${s.blocks.map(renderBlock).join("\n          ")}
        </section>`,
    )
    .join("");
  const others = LEGAL_DOCS.filter((d) => d.slug !== doc.slug)
    .map((d) => anchor(`/${d.slug}`, d.title))
    .join(" · ");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(doc.title)} · ASafariM OS</title>
    <meta name="description" content="${escapeHtml(doc.description)}" />
    <meta name="color-scheme" content="light dark" />
    <link rel="canonical" href="${SITE_URL}${doc.slug}" />${shareMeta(`${doc.title} · ASafariM OS`, doc.description, `${SITE_URL}${doc.slug}`)}
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/theme.css" />
    <link rel="stylesheet" href="/styles.css" />
    <script src="/theme.js"></script>
    <script src="/session.js" defer></script>
  </head>
  <body>${renderTopbar(options.themeToggle ?? "", "/")}
    <main class="legal">
      <h1>${escapeHtml(doc.title)}</h1>
      <p class="lead">${escapeHtml(doc.lead)}</p>
      <nav class="legal-toc" aria-label="On this page"><ol>${toc}</ol></nav>${sections}
      <p class="legal-meta">Last updated ${escapeHtml(formatDate(LEGAL_UPDATED))}. See also ${others}.</p>
    </main>
${renderFooter(options.repo)}
  </body>
</html>
`;
}
