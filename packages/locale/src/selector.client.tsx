/**
 * The browser side of @asafarim/locale: @asafarim/country-language-selector (the same component as
 * asafarim.com) on every `[data-locale-selector]` that `localeSwitcher()` rendered. Bundled with React into
 * selector.js by scripts/build-selector.ts, so pages load one file of their own origin (`script-src 'self'`)
 * and need no React.
 *
 * Choosing a language remembers it in the asafarim-locale cookie on the parent domain, then goes to that
 * language's link from the mount's fallback markup (read before the selector replaces it), so where each
 * language lives is decided only by the page. Without a link it sets ?lang= on the current URL.
 */
import { CountryLanguageSelector } from "@asafarim/country-language-selector";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  cookieDomain,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  parseLocale,
  SELECTOR_LABEL,
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

function remember(locale: string) {
  const domain = cookieDomain(window.location.hostname);
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${
    domain ? `; Secure; Domain=${domain}` : ""
  }`;
}

for (const mount of Array.from(document.querySelectorAll<HTMLElement>("[data-locale-selector]"))) {
  const current = parseLocale(mount.getAttribute("data-lang")) ?? DEFAULT_LOCALE;
  const hrefs = new Map<string, string>();
  for (const a of Array.from(mount.querySelectorAll<HTMLAnchorElement>("a[hreflang]"))) hrefs.set(a.hreflang, a.href);
  createRoot(mount).render(
    createElement(CountryLanguageSelector, {
      countries: COUNTRIES,
      value: { country: "BE", language: current },
      triggerVariant: "compact",
      align: "end",
      ariaLabel: SELECTOR_LABEL,
      onChange: (next: { language: string }, meta?: { reason?: string }) => {
        const locale = parseLocale(next.language);
        if (meta?.reason === "init" || !locale || locale === current) return;
        remember(locale);
        const target = hrefs.get(locale);
        if (target) return window.location.assign(target);
        const url = new URL(window.location.href);
        url.searchParams.set("lang", locale);
        window.location.assign(url.toString());
      },
    }),
  );
}
