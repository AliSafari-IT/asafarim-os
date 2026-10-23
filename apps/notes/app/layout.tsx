import { parseTheme, THEME_COOKIE } from "@asafarim/theme";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import "@asafarim/theme/theme.css";
import "./globals.css";

export const metadata: Metadata = { title: "Notes · ASafariM", description: "The ASafariM OS reference app" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The light/dark choice made with the toggle on any *.asafarim.site page; none = follow the system.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme}>
      <body>{children}</body>
    </html>
  );
}
