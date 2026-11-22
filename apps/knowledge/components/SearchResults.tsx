/** A page of search hits: title, where the match is (the section, linked), the snippet with matches marked. */
import Link from "next/link";
import { snippetParts, type SearchHit } from "@/lib/search";

const date = (d: Date) => d.toISOString().slice(0, 10);

export function SearchResults({ hits }: { hits: SearchHit[] }) {
  return (
    <ol className="article-list search-results" data-testid="results">
      {hits.map((h) => (
        <li key={h.slug} className="card" data-testid="result">
          <h2>
            <Link href={`/articles/${h.slug}`}>{h.title}</Link>
          </h2>
          {h.section ? (
            <p className="muted">
              In{" "}
              <Link href={`/articles/${h.slug}#${h.section.anchor}`} data-testid="result-section">
                {h.section.heading}
              </Link>
            </p>
          ) : null}
          {h.snippet ? (
            <p className="snippet" data-testid="snippet">
              {snippetParts(h.snippet).map((p, i) =>
                p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>,
              )}
            </p>
          ) : null}
          <span className="muted">
            {h.topic ? (
              <>
                <Link href={`/topics/${h.topic.slug}`}>{h.topic.name}</Link> ·{" "}
              </>
            ) : null}
            {h.level ? <>{h.level} · </> : null}
            Published {date(h.publishedAt)}
          </span>
        </li>
      ))}
    </ol>
  );
}
