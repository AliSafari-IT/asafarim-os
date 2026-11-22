/**
 * Public search (#357): a query and facet filters (topic, technology, level, language) over published articles
 * only. Rate limited per client like the API; the filters apply before ranking and paging (lib/search.ts).
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { SearchResults } from "@/components/SearchResults";
import { Pager } from "@/components/Pager";
import { TopBar } from "@/components/TopBar";
import { db } from "@/lib/db";
import { clientKey, searchLimiter } from "@/lib/rate-limit";
import { normaliseFilters, searchPublished, type SearchPage } from "@/lib/search";
import { LEVELS, listTags, listTopics, type Tag, type Topic } from "@/lib/taxonomy";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Search" };

type Props = { searchParams: Promise<Record<string, string | undefined>> };

export default async function SearchPage({ searchParams }: Props) {
  const sp = await searchParams;
  const q = (sp.q ?? "").slice(0, 200);
  const filters = normaliseFilters({
    topic: sp.topic,
    technology: sp.technology,
    level: sp.level,
    language: sp.language,
  });
  const asked = Boolean(q.trim() || filters.topic || filters.technology || filters.level || filters.language);

  let page: SearchPage | null = null;
  let topics: Topic[] = [];
  let technologies: Tag[] = [];
  let error: "unavailable" | "rate_limited" | null = null;
  try {
    const pool = await db();
    [topics, technologies] = await Promise.all([
      listTopics(pool),
      listTags(pool).then((t) => t.filter((x) => x.kind === "technology")),
    ]);
    if (asked) {
      const limited = searchLimiter.take(clientKey(await headers()));
      if (!limited.ok) error = "rate_limited";
      else page = await searchPublished(pool, { q, filters, after: sp.after });
    }
  } catch {
    error = "unavailable";
  }
  const keep = new URLSearchParams(
    Object.entries({ q, ...filters }).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""),
  );
  const base = `/search?${keep}`;

  return (
    <>
      <TopBar next="/search" />
      <main>
        <h1>Search</h1>
        <form action="/search" method="get" className="card search-form" role="search" data-testid="search-form">
          <label>
            Words, identifiers or a title
            <input
              name="q"
              type="search"
              defaultValue={q}
              maxLength={200}
              placeholder="useEffect, ERR_CONNECTION_RESET, C#…"
              data-testid="search-q"
            />
          </label>
          <div className="facets">
            <label>
              Topic
              <select name="topic" defaultValue={filters.topic ?? ""} data-testid="facet-topic">
                <option value="">Any</option>
                {topics.map((t) => (
                  <option key={t.id} value={t.slug}>
                    {t.parentId ? `— ${t.name}` : t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Technology
              <select name="technology" defaultValue={filters.technology ?? ""} data-testid="facet-technology">
                <option value="">Any</option>
                {technologies.map((t) => (
                  <option key={t.id} value={t.slug}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Level
              <select name="level" defaultValue={filters.level ?? ""} data-testid="facet-level">
                <option value="">Any</option>
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Language
              <select name="language" defaultValue={filters.language ?? ""}>
                <option value="">Any</option>
                <option value="en">English</option>
                <option value="nl">Nederlands</option>
                <option value="fr">Français</option>
                <option value="de">Deutsch</option>
              </select>
            </label>
          </div>
          <button type="submit" data-testid="search-submit">
            Search
          </button>
        </form>

        {error === "rate_limited" ? (
          <div className="notice bad" role="alert" data-testid="rate-limited">
            Too many searches in a short time. Wait a moment and try again.
          </div>
        ) : error ? (
          <div className="notice bad" role="alert">
            Search is unavailable right now. Try again in a moment.
          </div>
        ) : null}
        {page && page.items.length === 0 ? (
          <p className="muted" data-testid="no-results">
            Nothing published matches that. Try fewer words, or another spelling.
          </p>
        ) : null}
        {page && page.items.length ? <SearchResults hits={page.items} /> : null}
        <Pager after={sp.after} next={page?.next ?? null} base={base} label="More results" first="← First results" />
      </main>
    </>
  );
}
