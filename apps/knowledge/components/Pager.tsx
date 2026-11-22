import Link from "next/link";

/** "Newest" and "Older" links for a keyset-paged list: the cursor is opaque, so there's no page count. */
export function Pager({
  after,
  next,
  base,
  label,
  first = "← Newest",
}: {
  after?: string;
  next: string | null;
  /** The list's URL, possibly with its own query (the search keeps its filters). */
  base: string;
  label: string;
  first?: string;
}) {
  if (!after && !next) return null;
  return (
    <nav className="pager" aria-label="Pages" data-testid="pager">
      {after ? <Link href={base}>{first}</Link> : <span />}
      {next ? (
        <Link
          href={`${base}${base.includes("?") ? "&" : "?"}after=${encodeURIComponent(next)}`}
          data-testid="pager-older"
        >
          {label} →
        </Link>
      ) : null}
    </nav>
  );
}
