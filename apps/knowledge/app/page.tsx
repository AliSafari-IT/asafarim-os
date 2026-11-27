/**
 * The public home page: published articles only. Open to anyone (no permission on "/" at the gateway);
 * listPublished can only read the revision each item's published pointer names. Each card says who wrote the
 * article, when, and how long it takes to read; the newest one is featured.
 */
import Link from "next/link";
import { ArticleByline } from "@/components/ArticleByline";
import { Pager } from "@/components/Pager";
import { TopBar } from "@/components/TopBar";
import { listPublished, type Page, type PublishedArticle } from "@/lib/content";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | undefined>> };

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default async function Home({ searchParams }: Props) {
  const { after } = await searchParams;
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
