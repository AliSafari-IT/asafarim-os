import type { Metadata } from "next";

// Never indexed (next.config.ts also sends X-Robots-Tag and no-store on /studio/**).
export const metadata: Metadata = { title: "Studio", robots: { index: false, follow: false } };

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return children;
}
