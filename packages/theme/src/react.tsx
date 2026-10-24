"use client";
/**
 * The light/dark toggle for React (Next.js) apps: the same button as toggle.html, driven by theme.js,
 * which this module loads in the browser. Put the app's server-read choice on <html> yourself
 * (`data-theme={parseTheme(cookie)}` with THEME_COOKIE from `@asafarim/theme`) and load
 * `@asafarim/theme/theme.css`.
 */
import { useEffect } from "react";
import "../theme.js";
import { LEGAL_LINKS, PRIVACY_EMAIL, PRODUCT_LINKS } from "./index.ts";

/** What theme.js puts on window (the package has no DOM types, like @asafarim/app-sdk). */
const themeScript = () => (globalThis as { asafarimTheme?: { sync(): void } }).asafarimTheme;

export function ThemeToggle({ className }: { className?: string }) {
  // theme.js owns aria-pressed (it knows the system's preference); bring this button in line once mounted.
  useEffect(() => themeScript()?.sync(), []);
  return (
    <button
      type="button"
      className={className ? `os-theme-toggle ${className}` : "os-theme-toggle"}
      data-theme-toggle=""
      aria-label="Dark theme"
      aria-pressed="false"
      title="Light or dark theme"
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
export function LegalFooter({ app }: { app?: string }) {
  return (
    <footer className="os-legal" data-testid="legal-footer">
      <nav aria-label="Legal">
        {app ? <span>{app} · ASafariM OS</span> : <span>ASafariM OS</span>}
        {LEGAL_LINKS.map((l) => (
          <a key={l.href} href={l.href}>
            {l.label}
          </a>
        ))}
        <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>
      </nav>
      <nav aria-label="More from ASafariM">
        <span>More from ASafariM</span>
        {PRODUCT_LINKS.map((l) => (
          <a key={l.href} href={l.href}>
            {l.label}
          </a>
        ))}
      </nav>
    </footer>
  );
}
