/**
 * @asafarim/locale: the languages of ASafariM OS and how a page picks one, shared by every site and app (like
 * @asafarim/theme for the look). English, Dutch, French and German: Belgium's three languages plus English, as
 * on asafarim.com. English is the default.
 *
 * The visitor's choice is kept in the `asafarim-locale` cookie on the parent domain, so it holds on every
 * *.asafarim.site host. The selector is a file of this package (`@asafarim/locale/selector.js` and
 * `selector.css`): @asafarim/country-language-selector bundled once, so a page needs no React and upgrading
 * the component here upgrades every site and app. It mounts on the markup `localeSwitcher()` returns, whose
 * plain links stay the fallback without JavaScript.
 */

export const LOCALES = ["en", "nl", "fr", "de"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** The cookie the selector writes: a locale, on the parent domain (every *.asafarim.site host). */
export const LOCALE_COOKIE = "asafarim-locale";

/** A year, in seconds: how long the choice is remembered. */
export const LOCALE_COOKIE_MAX_AGE = 31_536_000;

/** Each language in its own words (for links, menus and `title` attributes). */
export const LANGUAGE_NAMES: Readonly<Record<Locale, string>> = {
  en: "English",
  nl: "Nederlands",
  fr: "Français",
  de: "Deutsch",
};

/** Open Graph's `og:locale` for each language: Belgian for nl, fr and de. */
export const OG_LOCALES: Readonly<Record<Locale, string>> = { en: "en_GB", nl: "nl_BE", fr: "fr_BE", de: "de_BE" };

/** One accessible name for the selector that reads in every language. */
export const SELECTOR_LABEL = "Language · Taal · Langue · Sprache";

const isLocale = (value: string): value is Locale => (LOCALES as readonly string[]).includes(value);

/** A value as a locale: `nl`, `NL` and `nl-BE` are Dutch; anything else is no locale. */
export function parseLocale(value: string | null | undefined): Locale | undefined {
  if (!value) return undefined;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return isLocale(primary) ? primary : undefined;
}

/** The locale in a request's Cookie header, if one was picked. */
export function localeFromCookieHeader(header: string | null | undefined): Locale | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === LOCALE_COOKIE) return parseLocale(part.slice(eq + 1));
  }
  return undefined;
}

/** The best supported locale in an Accept-Language header (by q, then by order), if any. */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | undefined {
  if (!header) return undefined;
  const ranked = header
    .split(",")
    .slice(0, 32)
    .map((entry, index) => {
      const [tag = "", ...params] = entry.trim().split(";");
      const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find(Boolean);
      return { locale: parseLocale(tag), q: q === undefined ? 1 : Number(q), index };
    })
    .filter((e): e is { locale: Locale; q: number; index: number } => !!e.locale && e.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  return ranked[0]?.locale;
}

export interface LocaleInputs {
  /** An explicit choice in the URL (`?lang=`, or a path prefix such as /nl/). */
  query?: string | null;
  /** The request's Cookie header. */
  cookieHeader?: string | null;
  /** The request's Accept-Language header. */
  acceptLanguage?: string | null;
}

export type LocaleSource = "query" | "cookie" | "browser" | "default";

/**
 * The page's language: the URL's choice, then the remembered one, then the browser's, then English. `source`
 * tells a server whether to remember it (`query`: set the cookie with `localeCookie()`).
 */
export function negotiateLocale(
  inputs: LocaleInputs,
  fallback: Locale = DEFAULT_LOCALE,
): { locale: Locale; source: LocaleSource } {
  const query = parseLocale(inputs.query);
  if (query) return { locale: query, source: "query" };
  const cookie = localeFromCookieHeader(inputs.cookieHeader);
  if (cookie) return { locale: cookie, source: "cookie" };
  const browser = localeFromAcceptLanguage(inputs.acceptLanguage);
  if (browser) return { locale: browser, source: "browser" };
  return { locale: fallback, source: "default" };
}

/**
 * The domain to share the cookie on: the host's last two labels (`id.asafarim.site` → `asafarim.site`), or
 * none for localhost and IP addresses. The same rule as selector.js and @asafarim/theme.
 */
export function cookieDomain(host: string | null | undefined): string {
  const name = (host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (!name || name === "localhost" || name.endsWith(".localhost") || /^[\d.]+$/.test(name) || name.includes(":"))
    return "";
  const labels = name.split(".");
  return labels.length < 2 ? "" : labels.slice(-2).join(".");
}

/** A Set-Cookie value that remembers `locale` for the host's parent domain (see `cookieDomain`). */
export function localeCookie(locale: Locale, host?: string | null): string {
  const domain = cookieDomain(host);
  const secure = domain ? "; Secure" : "";
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${secure}${domain ? `; Domain=${domain}` : ""}`;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/** Where each language's version of the current page is. */
export type LocaleHref = (locale: Locale) => string;

/**
 * The selector's mount point, with one plain link per language inside: the current one marked, the others
 * pointing at that language's version of this page. selector.js replaces it with the country & language
 * selector and navigates to the same links, so the URLs are only ever the server's or the build's.
 */
export function localeSwitcher(current: Locale, href: LocaleHref, options: { className?: string } = {}): string {
  const links = LOCALES.map((l) =>
    l === current
      ? `<span aria-current="true" lang="${l}">${l.toUpperCase()}</span>`
      : `<a href="${esc(href(l))}" hreflang="${l}" lang="${l}" title="${LANGUAGE_NAMES[l]}">${l.toUpperCase()}</a>`,
  ).join("");
  const extra = options.className ? ` ${esc(options.className)}` : "";
  return `<div class="locale-selector${extra}" data-locale-selector data-lang="${current}"><div class="locale-links" role="group" aria-label="${SELECTOR_LABEL}">${links}</div></div>`;
}

/** `<link rel="alternate" hreflang>` for every language (absolute URLs), plus x-default for English. */
export function alternateLinks(href: LocaleHref): string {
  return [...LOCALES.map((l) => [l, href(l)] as const), ["x-default", href(DEFAULT_LOCALE)] as const]
    .map(([l, url]) => `<link rel="alternate" hreflang="${l}" href="${esc(url)}" />`)
    .join("\n    ");
}
