import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Admin · ASafariM OS", description: "The ASafariM OS Admin console" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
