/**
 * Renders the asafarim.site landing page from the progress file. Pure: progress in, HTML out.
 *
 * The page is static HTML, one stylesheet and one small script of this origin's own (session.js, which
 * asks identity who is signed in and swaps "Sign in" for their avatar): no inline scripts or styles, no
 * web fonts, no third-party assets. That is what lets the edge serve it under a CSP with
 * `script-src 'self'` and `connect-src` identity only (sites/asafarim-os.caddy).
 */
import { readFileSync } from "node:fs";
import { alternateLinks, localeSwitcher, OG_LOCALES } from "../../../packages/locale/src/index.ts";
import { type Locale, localePath, PRODUCT_HREFS, type SiteText, TEXT } from "./i18n.ts";
import { LEGAL_DOCS, LEGAL_UPDATED, type LegalBlock, type LegalDoc } from "./legal.ts";
import { type App, pullRequestUrl, type Progress, type Surface } from "./progress.ts";
import { localizeProgress } from "./progress-i18n.ts";

const { version: siteVersion } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export interface ImageSize {
  width: number;
  height: number;
}

export interface RenderOptions {
  /** Pixel size of each screenshot by file name, so the browser reserves the space (no layout shift). */
  imageSizes: ReadonlyMap<string, ImageSize>;
  /** The light/dark toggle's markup (@asafarim/theme's toggle.html), put in the top bar. Default: none. */
  themeToggle?: string;
  /** The page's language (i18n.ts). Default: English, at /. */
  locale?: Locale;
}

export const SITE_URL = "https://asafarim.site/";
export const TITLE = TEXT.en.title;
export const DESCRIPTION = TEXT.en.description;

/** A page's absolute URL in a language: "" the home page, "privacy" a legal page. */
export const pageUrl = (locale: Locale, page = "") => `${SITE_URL.slice(0, -1)}${localePath(locale, page)}`;

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
export function shareMeta(title: string, description: string, url: string, locale: Locale = "en"): string {
  return `
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="ASafariM OS" />
    <meta property="og:locale" content="${OG_LOCALES[locale]}" />
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
export function structuredData(repo: string, locale: Locale = "en"): string {
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
        url: pageUrl(locale),
        name: "ASafariM OS",
        description: TEXT[locale].description,
        inLanguage: locale,
        publisher: { "@id": `${SITE_URL}#org` },
      },
    ],
  };
  return `
    <script type="application/ld+json">${JSON.stringify(graph).replaceAll("<", "\\u003c")}</script>`;
}

/** "2026-10-03" → "3 Oct 2026" ("3 okt 2026" in Dutch), the same in every time zone. */
export function formatDate(iso: string, locale: Locale = "en"): string {
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${TEXT[locale].months[(month ?? 1) - 1]} ${year}`;
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
  observatory: { label: "Observatory", href: "https://observatory.asafarim.site/" },
  breinhap: { label: "Breinhap", href: "https://breinhap.asafarim.site/en/" },
  breinhapWeb: { label: "Breinhap web", href: "https://breinhap.com/en/" },
  breinhapManagement: { label: "Breinhap management", href: "https://management.breinhap.com/login" },
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

/** The top bar's language selector (@asafarim/locale): to the same page in each language. */
function localeMenu(locale: Locale, page: string): string {
  return localeSwitcher(locale, (l) => localePath(l, page), { className: "nav-locale-selector" });
}

function renderTopbar(t: SiteText, locale: Locale, themeToggle: string, page = ""): string {
  const home = localePath(locale);
  const products = (key: keyof typeof PRODUCT_HREFS) => PRODUCT_HREFS[key][locale];
  return `
    <div class="os-topbar">
    <nav class="topbar" aria-label="${escapeHtml(t.nav.main)}">
      <a class="brand" href="${home}">${BRAND_MARK}<span class="brand-name">ASafariM <span>OS</span></span></a>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="primary-nav" aria-label="${escapeHtml(t.nav.open)}" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
      </button>
      <ul class="primary-nav" id="primary-nav">
        <li>
          <details class="nav-dropdown">
            <summary>${t.nav.apps} <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m3.5 6 4.5 4 4.5-4" /></svg></summary>
            <div class="nav-panel">
              <div class="nav-panel-heading"><strong>${t.nav.workspace}</strong><span>${t.nav.workspaceLead}</span></div>
              <div class="nav-card-grid">
                <a class="nav-card" href="${APP_LINKS.observatory.href}" aria-label="Observatory">
                  <span class="nav-card-icon nav-card-flow" aria-hidden="true">OB</span>
                  <span class="nav-card-copy"><strong>Observatory</strong><small>${t.nav.observatory}</small></span><span class="nav-card-arrow" aria-hidden="true">↗</span>
                </a>
                <a class="nav-card" href="${APP_LINKS.docs.href}" aria-label="Docs">
                  <span class="nav-card-icon nav-card-docs" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3.75h8l4 4v12.5H6zM14 3.75v4.5h4M9 12h6M9 15.5h6" /></svg></span>
                  <span class="nav-card-copy"><strong>Docs</strong><small>${t.nav.docs}</small></span><span class="nav-card-arrow" aria-hidden="true">↗</span>
                </a>
                <a class="nav-card" href="${APP_LINKS.flow.href}" aria-label="Flow">
                  <span class="nav-card-icon nav-card-flow" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="5" height="5" rx="1" /><rect x="15" y="15" width="5" height="5" rx="1" /><path d="M9 6.5h4a2 2 0 0 1 2 2v4.5M15 13v2" /></svg></span>
                  <span class="nav-card-copy"><strong>Flow</strong><small>${t.nav.flow}</small></span><span class="nav-card-arrow" aria-hidden="true">↗</span>
                </a>
                <a class="nav-card" href="${products("breinhapWeb")}" aria-label="Breinhap web">
                  <span class="nav-card-icon nav-card-docs" aria-hidden="true">BH</span>
                  <span class="nav-card-copy"><strong>Breinhap web</strong><small>${t.nav.breinhapWeb}</small></span><span class="nav-card-arrow" aria-hidden="true">↗</span>
                </a>
                <a class="nav-card" href="${APP_LINKS.breinhapManagement.href}" aria-label="Breinhap management">
                  <span class="nav-card-icon nav-card-flow" aria-hidden="true">BH</span>
                  <span class="nav-card-copy"><strong>Breinhap management</strong><small>${t.nav.breinhapManagement}</small></span><span class="nav-card-arrow" aria-hidden="true">↗</span>
                </a>
              </div>
              <p class="nav-panel-foot">${t.nav.appsFoot} <a href="${home}#apps">${t.nav.everyApp}</a></p>
            </div>
          </details>
        </li>
        <li>
          <details class="nav-dropdown">
            <summary>${t.nav.products} <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m3.5 6 4.5 4 4.5-4" /></svg></summary>
            <div class="nav-panel nav-panel-compact">
              <div class="nav-panel-heading"><strong>${t.nav.moreFrom}</strong><span>${t.nav.explore}</span></div>
              <a class="nav-product-link" href="${products("breinhap")}" aria-label="Breinhap"><strong>Breinhap</strong><span>${t.nav.breinhap}</span><span aria-hidden="true">↗</span></a>
              <a class="nav-product-link" href="${products("observatory")}" aria-label="Observatory"><strong>Observatory</strong><span>${t.nav.observatory}</span><span aria-hidden="true">↗</span></a>
              <a class="nav-product-link" href="${products("igs")}" aria-label="IGS-Pharma"><strong>IGS-Pharma</strong><span>${t.nav.igs}</span><span aria-hidden="true">↗</span></a>
              <p class="nav-panel-foot"><a href="${home}#apps-products">${t.nav.productsFoot}</a></p>
            </div>
          </details>
        </li>
        <li><a class="nav-link" href="${home}#shipped">${t.nav.platform}</a></li>
        <li class="nav-locale">${localeMenu(locale, page)}</li>
${themeToggle ? `        <li class="nav-theme">${themeToggle.trim()}</li>\n` : ""}        <li id="account">${anchor(APP_LINKS.signIn.href, t.nav.signIn, ' class="btn btn-small"')}</li>
      </ul>
    </nav>
    </div>`;
}

function renderAccess(t: SiteText): string {
  return `
      <p class="access" id="access">
        ${t.access(anchor(APP_LINKS.signIn.href, t.nav.signIn), anchor(APP_LINKS.docs.href, "Docs"), anchor(APP_LINKS.flow.href, "Flow"))}
      </p>`;
}

/** The milestones: a changelog of merged pull requests, English on every page (lang="en" elsewhere). */
function renderShipped(progress: Progress, t: SiteText, locale: Locale): string {
  const items = progress.shipped
    .map((m) => {
      const prs = m.prs.map((n) => anchor(pullRequestUrl(progress.repo, n), `#${n}`)).join(", ");
      return `
        <li class="milestone">
          <div class="milestone-head">
            <span class="tag">${escapeHtml(m.id)}</span>
            <h3>${escapeHtml(m.title)}</h3>
            <time datetime="${escapeHtml(m.date)}">${escapeHtml(formatDate(m.date, locale))}</time>
          </div>
          <p>${escapeHtml(m.summary)}</p>
          <p class="prs"${locale === "en" ? "" : ` lang="${locale}"`}>${escapeHtml(t.shipped.prs)} ${prs}</p>
        </li>`;
    })
    .join("");
  return `
      <section id="shipped" aria-labelledby="shipped-title">
        <h2 id="shipped-title">${escapeHtml(t.shipped.title)}</h2>
        <p class="section-lead">${escapeHtml(t.shipped.lead)}${t.shipped.inEnglish ? ` ${escapeHtml(t.shipped.inEnglish)}` : ""}</p>
        <ol class="milestones"${locale === "en" ? "" : ' lang="en"'}>${items}
        </ol>
      </section>`;
}

function renderScreenshots(progress: Progress, sizes: RenderOptions["imageSizes"], t: SiteText): string {
  const figures = progress.screenshots
    .map((s) => {
      const size = sizes.get(s.file);
      if (!size) throw new Error(`render: no size for screenshots/${s.file} (is the file there?)`);
      return `
          <figure>
            <img src="/screenshots/${escapeHtml(s.file)}" alt="${escapeHtml(s.alt)}" width="${size.width}" height="${size.height}" loading="lazy" decoding="async" />
            <figcaption><strong>${escapeHtml(s.title)}.</strong> ${escapeHtml(s.caption)}</figcaption>
          </figure>`;
    })
    .join("");
  return `
      <section id="screenshots" aria-labelledby="screenshots-title">
        <h2 id="screenshots-title">${escapeHtml(t.screenshots.title)}</h2>
        <p class="section-lead">${escapeHtml(t.screenshots.lead)}</p>
        <div class="gallery">${figures}
        </div>
      </section>`;
}

function renderRoadmap(progress: Progress, t: SiteText): string {
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
        <h2 id="roadmap-title">${escapeHtml(t.roadmap.title)}</h2>
        <ol class="roadmap">${items}
        </ol>
      </section>`;
}

function renderSurface(surface: Surface, t: SiteText): string {
  const address = surface.href
    ? anchor(surface.href, surface.address)
    : `<span class="surface-address">${escapeHtml(surface.address)}</span>`;
  return `
              <li class="surface">
                <span class="surface-kind">${escapeHtml(surface.kind)}</span>
                ${address}
                <span class="status status-${surface.status}">${escapeHtml(t.status[surface.status])}</span>
                <p class="surface-note">${escapeHtml(surface.note)}</p>
              </li>`;
}

function renderAppCard(app: App, t: SiteText): string {
  return `
          <li class="app-card app-card-${app.group}" id="app-${escapeHtml(app.id)}">
            <h4>${escapeHtml(app.name)}</h4>
            <p class="app-tagline">${escapeHtml(app.tagline)}</p>
            <p class="app-summary">${escapeHtml(app.summary)}</p>
            <ul class="surfaces" aria-label="${escapeHtml(t.apps.whereToFind(app.name))}">${app.surfaces.map((s) => renderSurface(s, t)).join("")}
            </ul>
          </li>`;
}

/**
 * The apps (asafarim-os#312): the OS's own apps, then the products ASafariM builds on their own domains
 * (IGS-Pharma, Breinhap), each with every place it can be reached and how far that is. Products'
 * pages are linked in the page's language where they have it (i18n.ts PRODUCT_HREFS).
 */
function renderApps(progress: Progress, t: SiteText): string {
  const group = (g: App["group"]) =>
    progress.apps
      .filter((a) => a.group === g)
      .map((a) => renderAppCard(a, t))
      .join("");
  return `
      <section id="apps" aria-labelledby="apps-title">
        <h2 id="apps-title">${escapeHtml(t.apps.title)}</h2>
        <p class="section-lead">${escapeHtml(t.apps.lead)}</p>
        <h3 class="apps-group" id="apps-os">${escapeHtml(t.apps.os)}</h3>
        <ul class="app-grid" aria-labelledby="apps-os">${group("os")}
        </ul>
        <h3 class="apps-group" id="apps-products">${escapeHtml(t.apps.products)}</h3>
        <p class="section-lead">${escapeHtml(t.apps.productsLead)}</p>
        <ul class="app-grid app-grid-products" aria-labelledby="apps-products">${group("product")}
        </ul>
      </section>`;
}

/** The <head> lines every page shares: icons, the shared look and the language selector (@asafarim/locale). */
function assets(): string {
  return `
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/theme.css" />
    <link rel="stylesheet" href="/selector.css" />
    <link rel="stylesheet" href="/styles.css" />
    <script src="/theme.js"></script>
    <script src="/selector.js" defer></script>
    <script src="/session.js" defer></script>`;
}

/** The whole page, in `options.locale` (English by default). */
export function renderPage(englishProgress: Progress, options: RenderOptions): string {
  const locale = options.locale ?? "en";
  const t = TEXT[locale];
  const progress = localizeProgress(englishProgress, locale);
  const links = progress.links.map((l) => anchor(l.href, l.label, ' class="btn"')).join("\n          ");
  const benefits = t.benefits.map((b) => `<li>${escapeHtml(b)}</li>`).join("");
  const url = pageUrl(locale);
  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(t.title)}</title>
    <meta name="description" content="${escapeHtml(t.description)}" />
    <meta name="color-scheme" content="light dark" />
    <link rel="canonical" href="${url}" />
    ${alternateLinks((l) => pageUrl(l))}${shareMeta(t.title, t.description, url, locale)}${structuredData(progress.repo, locale)}${assets()}
  </head>
  <body>${renderTopbar(t, locale, options.themeToggle ?? "")}
    <header class="hero">${HERO_ART}
      <span class="badge">${escapeHtml(t.badge(formatDate(progress.updated, locale)))}</span>
      <h1>ASafariM <span>OS</span></h1>
      <p class="lead">
        ${escapeHtml(t.lead)}
      </p>
      <ul class="benefits" aria-label="${escapeHtml(t.benefitsLabel)}">${benefits}</ul>
      <p class="note">
        ${escapeHtml(t.note)}
      </p>
      <nav class="actions" aria-label="${escapeHtml(t.linksLabel)}">
          ${links}
      </nav>${renderAccess(t)}
    </header>
    <main>${renderApps(progress, t)}${renderShipped(progress, t, locale)}${renderScreenshots(progress, options.imageSizes, t)}${renderRoadmap(progress, t)}
    </main>
${renderFooter(progress.repo, locale)}
  </body>
</html>
`;
}

/** The footer of every page here: the project's links, then the legal pages. */
function renderFooter(repo: string, locale: Locale): string {
  const t = TEXT[locale];
  const legal = LEGAL_DOCS.map((d) => anchor(localePath(locale, d.slug), t.legal.labels[d.slug])).join(" · ");
  return `    <footer>
      <p>ASafariM OS · ${escapeHtml(t.footer.website)} v${siteVersion} · ${anchor(repo, t.footer.source)} · ${anchor(APP_LINKS.observatory.href, "Observatory")} · ${anchor(APP_LINKS.docs.href, "Docs")} · ${anchor(APP_LINKS.flow.href, "Flow")} · ${anchor(PRODUCT_HREFS.breinhap[locale], "Breinhap")} · ${anchor(PRODUCT_HREFS.igs[locale], "IGS-Pharma")} · ${anchor("https://asafarim.com/", "asafarim.com")}</p>
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

/**
 * A legal page (privacy, cookies, terms), served at /<slug> and /<locale>/<slug>: the same top bar and footer as
 * the home page. The text itself is English until a reviewed translation exists: a translated page says so
 * and marks the text lang="en".
 */
export function renderLegalPage(
  doc: LegalDoc,
  options: { repo: string; themeToggle?: string; locale?: Locale },
): string {
  const locale = options.locale ?? "en";
  const t = TEXT[locale];
  const english = locale === "en" ? "" : ' lang="en"';
  const title = t.legal.titles[doc.slug];
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
    .map((d) => anchor(localePath(locale, d.slug), t.legal.titles[d.slug]))
    .join(" · ");
  const url = pageUrl(locale, doc.slug);
  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} · ASafariM OS</title>
    <meta name="description" content="${escapeHtml(doc.description)}"${english} />
    <meta name="color-scheme" content="light dark" />
    <link rel="canonical" href="${url}" />
    ${alternateLinks((l) => pageUrl(l, doc.slug))}${shareMeta(`${title} · ASafariM OS`, doc.description, url, locale)}${assets()}
  </head>
  <body>${renderTopbar(t, locale, options.themeToggle ?? "", doc.slug)}
    <main class="legal">
      <h1>${escapeHtml(title)}</h1>${t.legal.inEnglish ? `\n      <p class="legal-language" role="note">${escapeHtml(t.legal.inEnglish)}</p>` : ""}
      <div class="legal-body"${english}>
      <p class="lead">${escapeHtml(doc.lead)}</p>
      <nav class="legal-toc" aria-label="${escapeHtml(t.legal.onThisPage)}"><ol>${toc}</ol></nav>${sections}
      </div>
      <p class="legal-meta">${escapeHtml(t.legal.updated(formatDate(LEGAL_UPDATED, locale)))} ${escapeHtml(t.legal.seeAlso)} ${others}.</p>
    </main>
${renderFooter(options.repo, locale)}
  </body>
</html>
`;
}
