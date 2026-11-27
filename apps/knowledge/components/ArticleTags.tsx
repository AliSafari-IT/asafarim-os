import type { TagLink } from "@asafarim/tags";
import Link from "next/link";

export function ArticleTags({ tags }: { tags: TagLink[] }) {
  if (!tags.length) return null;
  return (
    <ul className="article-tags chips" aria-label="Tags">
      {tags.map((tag) => (
        <li key={tag.slug}>
          <Link href={`/tags/${tag.slug}`} className="chip" rel="tag">
            {tag.name}
          </Link>
        </li>
      ))}
    </ul>
  );
}
