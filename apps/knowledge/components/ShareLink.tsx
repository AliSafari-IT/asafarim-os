"use client";
/** One share link. The address and the look come from the server (components/ShareBar.tsx); this adds the count. */
import type { ReactNode } from "react";
import { trackShare } from "@/lib/analytics/beacon";
import type { ShareTarget } from "@/lib/analytics/classify";

export function ShareLink({
  href,
  id,
  slug,
  label,
  external,
  children,
}: {
  href: string;
  id: Exclude<ShareTarget, "copy">;
  slug: string;
  label: string;
  external: boolean;
  children: ReactNode;
}) {
  return (
    <a
      className="share-btn"
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      aria-label={label}
      data-testid={`share-${id}`}
      onClick={() => trackShare(slug, id)}
    >
      {children}
    </a>
  );
}
