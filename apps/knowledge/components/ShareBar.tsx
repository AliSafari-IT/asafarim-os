/**
 * Share an article: LinkedIn, X and email as plain links to each network's own share page (opened by the reader,
 * in a new tab, with nothing loaded from them into this page), plus "Copy link". See lib/share.ts.
 */
import { shareLinks, type ShareId } from "@/lib/share";
import { CopyLinkButton } from "./CopyLinkButton";
import { ShareLink } from "./ShareLink";

// Brand marks from Simple Icons (CC0).
const PATHS: Record<Exclude<ShareId, "email">, string> = {
  linkedin:
    "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
  x: "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
};

function Icon({ id }: { id: ShareId }) {
  if (id === "email") {
    return (
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        aria-hidden="true"
        focusable="false"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="currentColor">
      <path d={PATHS[id]} />
    </svg>
  );
}

export function ShareBar({
  url,
  title,
  slug,
  heading = "Share",
}: {
  url: string;
  title: string;
  /** The article's slug: what a click on a share button is counted against (lib/analytics). */
  slug: string;
  heading?: string;
}) {
  const links = shareLinks({ url, title });
  if (links.length === 0) return null;
  return (
    <nav className="share" aria-label="Share this article" data-testid="share">
      <span className="share-label">{heading}</span>
      <ul>
        {links.map((l) => (
          <li key={l.id}>
            <ShareLink
              href={l.href}
              id={l.id}
              slug={slug}
              label={l.id === "email" ? "Share by email" : `Share on ${l.label} (opens in a new tab)`}
              external={l.id !== "email"}
            >
              <Icon id={l.id} />
              <span>{l.label}</span>
            </ShareLink>
          </li>
        ))}
        <li>
          <CopyLinkButton url={url} slug={slug} />
        </li>
      </ul>
    </nav>
  );
}
