/**
 * The public home page: published articles only. Open to anyone (no permission on "/" at the gateway);
 * listPublished can only read the revision each item's published pointer names. Each card says who wrote the
 * article, when, and how long it takes to read; the newest one is featured.
 */
import { ArticleTags } from "@/components/ArticleTags";
import Link from "next/link";
import { ArticleByline } from "@/components/ArticleByline";
import { Pager } from "@/components/Pager";
import { TopBar } from "@/components/TopBar";
import { viewKey } from "@/lib/analytics/classify";
import { recordPageView } from "@/lib/analytics/server";
import { listPublished, type Page, type PublishedArticle } from "@/lib/content";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | undefined>> };

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default async function Home({ searchParams }: Props) {
  const { after } = await searchParams;
  await recordPageView(viewKey.home);
  let page: Page<PublishedArticle> | null;
  try {
    page = await listPublished(await db(), { after });
  } catch {
    page = null;
  }
  const articles = page?.items ?? null;

  return (
    <>
      <TopBar />
      <main className="home">
        <header className="home-hero">
          <p className="eyebrow">ASafariM Knowledge</p>
          <h1>Articles</h1>
          <p className="lead">Write, learn, and share technical knowledge.</p>
          <p className="home-actions">
            {/* A plain link, not next/link: the feed is a file, not a page. */}
            <a className="chip rss" href="/feed.xml" data-testid="rss-link">
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" fill="currentColor">
                <circle cx="5" cy="19" r="2.4" />
                <path d="M3 10.5v3.2a7.3 7.3 0 0 1 7.3 7.3h3.2A10.5 10.5 0 0 0 3 10.5Zm0-6.3v3.2A13.6 13.6 0 0 1 16.6 21h3.2A16.8 16.8 0 0 0 3 4.2Z" />
              </svg>
              RSS feed
            </a>
          </p>
        </header>
        {articles === null ? (
          <div className="notice bad" role="alert" data-testid="unavailable">
            Articles can&apos;t be loaded right now. Try again in a moment.
          </div>
        ) : articles.length === 0 ? (
          <p className="muted" data-testid="empty">
            Nothing is published yet.
          </p>
        ) : (
          <ul className="article-list feed" data-testid="articles">
            {articles.map((a, i) => {
              const featured = i === 0 && !after;
              return (
                <li
                  key={a.slug}
                  className={featured ? "card article-card featured" : "card article-card"}
                  data-testid="article-card"
                >
                  {featured || a.topic || a.level ? (
                    <p className="chips">
                      {featured ? <span className="chip latest">Latest</span> : null}
                      {a.topic ? (
                        <Link href={`/topics/${a.topic.slug}`} className="chip">
                          {a.topic.name}
                        </Link>
                      ) : null}
                      {a.level ? <span className="chip level">{capitalise(a.level)}</span> : null}
                    </p>
                  ) : null}
                  <h2>
                    <Link href={`/articles/${a.slug}`}>{a.title}</Link>
                  </h2>
                  {a.summary ? <p className="article-summary">{a.summary}</p> : null}
                  <ArticleTags tags={a.tags} />
                  <ArticleByline
                    authorName={a.authorName}
                    publishedAt={a.publishedAt}
                    readingMinutes={a.readingMinutes}
                    compact
                  />
                </li>
              );
            })}
          </ul>
        )}
        <Pager after={after} next={page?.next ?? null} base="/" label="Older articles" />
      </main>
    </>
  );
}
