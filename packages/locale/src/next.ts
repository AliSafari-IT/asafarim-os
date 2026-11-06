/**
 * The request's language for a Next.js server component or layout, from what `next/headers` gives:
 * the asafarim-locale cookie, then the browser's Accept-Language, then English (the same order as the static
 * sites; `?lang=` is handled by the selector, which sets the cookie and reloads).
 *
 *   const locale = await getLocale();
 */
import { cookies, headers } from "next/headers.js";
import { LOCALE_COOKIE, negotiateLocale, type Locale } from "./index.ts";

export async function getLocale(): Promise<Locale> {
  const [jar, h] = await Promise.all([cookies(), headers()]);
  const value = jar.get(LOCALE_COOKIE)?.value;
  return negotiateLocale({
    cookieHeader: value ? `${LOCALE_COOKIE}=${value}` : null,
    acceptLanguage: h.get("accept-language"),
  }).locale;
}
