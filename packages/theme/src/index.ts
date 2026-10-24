/**
 * @asafarim/theme for servers: the cookie that holds the light/dark choice and how to read it, so a
 * server-rendered page can put data-theme on <html> itself (no flash before theme.js runs). The CSS,
 * the browser script and the toggle's markup are files of this package:
 * `@asafarim/theme/theme.css`, `@asafarim/theme/theme.js`, `@asafarim/theme/toggle.html`.
 */

/** The cookie theme.js writes: `light` or `dark`, on the parent domain (every *.asafarim.site host). */
export const THEME_COOKIE = "asafarim-theme";

export type Theme = "light" | "dark";

/** A cookie value as a theme; anything else is no choice (follow the system). */
export function parseTheme(value: string | null | undefined): Theme | undefined {
  return value === "light" || value === "dark" ? value : undefined;
}

/** The theme in a request's Cookie header, if one was picked. */
export function themeFromCookieHeader(header: string | null | undefined): Theme | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === THEME_COOKIE) return parseTheme(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * The OS's legal pages, served by asafarim.site (core/site/src/legal.ts). Every OS host links them in its footer:
 * the Next.js apps with `<LegalFooter />` from `@asafarim/theme/react`, identity in its own page layout.
 */
export const LEGAL_LINKS = [
  { label: "Privacy", href: "https://asafarim.site/privacy" },
  { label: "Cookies", href: "https://asafarim.site/cookies" },
  { label: "Terms", href: "https://asafarim.site/terms" },
] as const;

/**
 * ASafariM's products outside the OS (each with its own site and policies), linked from every OS footer. English
 * pages, like the OS. A new one is added here, in core/site's top bar and "More from ASafariM", in identity's
 * footer and "Where to next", and in @asafarim/app-sdk's MORE_FROM_ASAFARIM.
 */
export const PRODUCT_LINKS = [
  { label: "Breinhap", href: "https://breinhap.asafarim.site/en/" },
  { label: "IGS-Pharma", href: "https://igs.asafarim.site/en/" },
] as const;

/** Where to write about personal data. */
export const PRIVACY_EMAIL = "privacy@asafarim.site";
