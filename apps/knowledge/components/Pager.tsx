import Link from "next/link";

/** "Newest" and "Older" links for a keyset-paged list: the cursor is opaque, so there's no page count. */
export function Pager({
  after,
  next,
  base,
  label,
}: {
  after?: string;
  next: string | null;
  base: string;
  label: string;
}) {
  if (!after && !next) return null;
  return (
    <nav className="pager" aria-label="Pages" data-testid="pager">
      {after ? <Link href={base}>← Newest</Link> : <span />}
      {next ? (
        <Link href={`${base}?after=${encodeURIComponent(next)}`} data-testid="pager-older">
          {label} →
        </Link>
      ) : null}
    </nav>
  );
}
