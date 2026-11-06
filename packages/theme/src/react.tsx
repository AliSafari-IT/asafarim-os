"use client";
/**
 * The light/dark toggle for React (Next.js) apps: the same button as toggle.html, driven by theme.js,
 * which this module loads in the browser. Put the app's server-read choice on <html> yourself
 * (`data-theme={parseTheme(cookie)}` with THEME_COOKIE from `@asafarim/theme`) and load
 * `@asafarim/theme/theme.css`.
 */
import { useEffect } from "react";
import "../theme.js";
import { PRIVACY_EMAIL, PRODUCT_LINKS } from "./index.ts";

/** The OS's four languages (the same codes as @asafarim/locale; English is the default everywhere). */
export type ThemeLocale = "en" | "nl" | "fr" | "de";

const WORDS: Record<
  ThemeLocale,
  { theme: string; toggle: string; legal: string; more: string; privacy: string; cookies: string; terms: string }
> = {
  en: {
    theme: "Dark theme",
    toggle: "Light or dark theme",
    legal: "Legal",
    more: "More from ASafariM",
    privacy: "Privacy",
    cookies: "Cookies",
    terms: "Terms",
  },
  nl: {
    theme: "Donker thema",
    toggle: "Licht of donker thema",
    legal: "Juridisch",
    more: "Meer van ASafariM",
    privacy: "Privacy",
    cookies: "Cookies",
    terms: "Voorwaarden",
  },
  fr: {
    theme: "Thème sombre",
    toggle: "Thème clair ou sombre",
    legal: "Mentions légales",
    more: "Plus d’ASafariM",
    privacy: "Confidentialité",
    cookies: "Cookies",
    terms: "Conditions",
  },
  de: {
    theme: "Dunkles Design",
    toggle: "Helles oder dunkles Design",
    legal: "Rechtliches",
    more: "Mehr von ASafariM",
    privacy: "Datenschutz",
    cookies: "Cookies",
    terms: "Bedingungen",
  },
};

/** The page of asafarim.site in a language (English at the root, the others under /nl/, /fr/, /de/). */
const site = (locale: ThemeLocale, path: string) =>
  `https://asafarim.site/${locale === "en" ? "" : `${locale}/`}${path}`;

/** What theme.js puts on window (the package has no DOM types, like @asafarim/app-sdk). */
const themeScript = () => (globalThis as { asafarimTheme?: { sync(): void } }).asafarimTheme;

export function ThemeToggle({ className, locale = "en" }: { className?: string; locale?: ThemeLocale }) {
  const w = WORDS[locale] ?? WORDS.en;
  // theme.js owns aria-pressed (it knows the system's preference); bring this button in line once mounted.
  useEffect(() => themeScript()?.sync(), []);
  return (
    <button
      type="button"
      className={className ? `os-theme-toggle ${className}` : "os-theme-toggle"}
      data-theme-toggle=""
      aria-label={w.theme}
      aria-pressed="false"
      title={w.toggle}
      suppressHydrationWarning
      data-testid="theme-toggle"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <mask id="os-theme-moon">
          <rect width="24" height="24" fill="#fff" />
          <circle className="os-theme-bite" cx="17.5" cy="6.5" r="6" fill="#000" />
        </mask>
        <circle className="os-theme-core" cx="12" cy="12" r="5" fill="currentColor" mask="url(#os-theme-moon)" />
        <path
          className="os-theme-rays"
          d="M12 1.5v2.5M12 20v2.5M1.5 12h2.5M20 12h2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </button>
  );
}

/**
 * The footer line every OS app ends with: the privacy, cookie and terms pages on asafarim.site, the privacy
 * contact, and ASafariM's other products. Put it last in <body> (styled by theme.css, `.os-legal`).
 */
export function LegalFooter({ app, locale = "en" }: { app?: string; locale?: ThemeLocale }) {
  const w = WORDS[locale] ?? WORDS.en;
  const legal = [
    { label: w.privacy, href: site(locale, "privacy") },
    { label: w.cookies, href: site(locale, "cookies") },
    { label: w.terms, href: site(locale, "terms") },
  ];
  const products = PRODUCT_LINKS.map((l) =>
    l.label === "Breinhap"
      ? { ...l, href: locale === "nl" ? "https://breinhap.asafarim.site/" : l.href }
      : { ...l, href: `https://igs.asafarim.site/${locale}/` },
  );
  return (
    <footer className="os-legal" data-testid="legal-footer">
      <nav aria-label={w.legal}>
        {app ? <span>{app} · ASafariM OS</span> : <span>ASafariM OS</span>}
        {legal.map((l) => (
          <a key={l.href} href={l.href}>
            {l.label}
          </a>
        ))}
        <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>
      </nav>
      <nav aria-label={w.more}>
        <span>{w.more}</span>
        {products.map((l) => (
          <a key={l.href} href={l.href}>
            {l.label}
          </a>
        ))}
      </nav>
    </footer>
  );
}
