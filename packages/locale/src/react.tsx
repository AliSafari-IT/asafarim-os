"use client";
/**
 * The country & language selector for the Next.js apps: the same component as asafarim.com and the static sites
 * (@asafarim/country-language-selector), with ASafariM's four languages. Choosing one remembers it in the
 * asafarim-locale cookie on the parent domain (one choice across every *.asafarim.site host) and reloads the
 * page so the server renders it in that language. Upgrading the selector means bumping it here, once.
 *
 *   <LocaleSelector locale={locale} />
 */
import { CountryLanguageSelector } from "@asafarim/country-language-selector";
import {
  cookieDomain,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  parseLocale,
  SELECTOR_LABEL,
  type Locale,
} from "./index.ts";

const COUNTRIES = [
  {
    code: "BE",
    name: "Belgium",
    nativeName: "België · Belgique · Belgien",
    flag: "🇧🇪",
    languages: [
      { code: "nl", label: "Dutch", nativeLabel: "Nederlands" },
      { code: "fr", label: "French", nativeLabel: "Français" },
      { code: "de", label: "German", nativeLabel: "Deutsch" },
      { code: "en", label: "English", nativeLabel: "English" },
    ],
  },
];

/** Remember a language for every *.asafarim.site host (a host-only cookie on localhost and IP addresses). */
export function rememberLocale(locale: Locale, host: string = window.location.hostname): string {
  const domain = cookieDomain(host);
  const cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${
    domain ? `; Secure; Domain=${domain}` : ""
  }`;
  document.cookie = cookie;
  return cookie;
}

export interface LocaleSelectorProps {
  /** The page's current language. */
  locale: Locale;
  /** What to do once the choice is remembered (default: reload, so the server renders the new language). */
  onChosen?: (locale: Locale) => void;
}

export function LocaleSelector({ locale, onChosen }: LocaleSelectorProps) {
  return (
    <CountryLanguageSelector
      countries={COUNTRIES}
      value={{ country: "BE", language: locale }}
      triggerVariant="compact"
      align="end"
      ariaLabel={SELECTOR_LABEL}
      onChange={(next: { language: string }, meta?: { reason?: string }) => {
        const chosen = parseLocale(next.language);
        if (meta?.reason === "init" || !chosen || chosen === locale) return;
        rememberLocale(chosen);
        if (onChosen) onChosen(chosen);
        else window.location.reload();
      }}
    />
  );
}
