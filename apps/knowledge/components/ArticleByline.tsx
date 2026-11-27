/**
 * Who wrote an article, and when: an avatar with the author's initials, "By <name>", the publication date and the
 * reading time. An article whose author hasn't signed in to the studio since names were kept (lib/authors.ts) is
 * credited to the site rather than to nobody.
 */
import { initialsOf } from "@/lib/authors";
import { formatPublished } from "@/lib/format";

export const SITE_BYLINE = "ASafariM Knowledge";

export function ArticleByline({
  authorName,
  publishedAt,
  readingMinutes,
  compact = false,
}: {
  authorName: string | null;
  publishedAt: Date;
  readingMinutes: number;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "byline compact" : "byline"} data-testid="byline">
      <span className="avatar" aria-hidden="true">
        {initialsOf(authorName)}
      </span>
      <span className="byline-text">
        <span className="byline-author" data-testid="byline-author">
          {authorName ? (
            <>
              By <strong>{authorName}</strong>
            </>
          ) : (
            <strong>{SITE_BYLINE}</strong>
          )}
        </span>
        <span className="byline-meta">
          <span className="visually-hidden">Published </span>
          <time dateTime={publishedAt.toISOString()} data-testid="published">
            {formatPublished(publishedAt)}
          </time>
          <span aria-hidden="true"> · </span>
          <span data-testid="reading-time">{readingMinutes} min read</span>
        </span>
      </span>
    </div>
  );
}
