import { parseTheme, THEME_COOKIE } from "@asafarim/theme";
import { LegalFooter } from "@asafarim/theme/react";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import manifest from "../platform.app";
import { publicOrigin } from "@/lib/site";
import "@asafarim/theme/theme.css";
import "./globals.css";

export const metadata: Metadata = {
  // Relative addresses in metadata (the share image) resolve against the real site, not the request's Host.
  metadataBase: new URL(publicOrigin()),
  title: { default: "ASafariM Knowledge", template: "%s · ASafariM Knowledge" },
  description: "Write, learn, and share technical knowledge.",
  openGraph: { siteName: "ASafariM Knowledge", type: "website", locale: "en_GB" },
  twitter: { card: "summary_large_image" },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The light/dark choice made with the toggle on any *.asafarim.site page; none = follow the system.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  // English first (proposal §3): the public pages and the studio are English in Phase 0.
  return (
    <html lang="en" data-theme={theme}>
      <body>
        {children}
        <p className="version muted" data-testid="app-version">
          ASafariM Knowledge {manifest.version}
        </p>
        <LegalFooter app="ASafariM Knowledge" />
      </body>
    </html>
  );
}
