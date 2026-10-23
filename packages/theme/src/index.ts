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
