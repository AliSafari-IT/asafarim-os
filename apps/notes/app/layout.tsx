import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Notes · ASafariM", description: "The ASafariM OS reference app" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
