import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Docs · ASafariM", description: "A private reader for documentation" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
