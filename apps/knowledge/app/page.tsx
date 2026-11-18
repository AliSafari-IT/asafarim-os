/**
 * The public home page: published articles only. Open to anyone (no permission on "/" at the gateway);
 * listPublished can only read the revision each item's published pointer names.
 */
import Link from "next/link";
import { Pager } from "@/components/Pager";
import { TopBar } from "@/components/TopBar";
import { listPublished, type Page, type PublishedArticle } from "@/lib/content";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const date = (d: Date) => d.toISOString().slice(0, 10);

type Props = { searchParams: Promise<Record<string, string | undefined>> };

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
      <main>
        <h1>Articles</h1>
        <p className="muted">Write, learn, and share technical knowledge.</p>
        {articles === null ? (
          <div className="notice bad" role="alert" data-testid="unavailable">
            Articles can&apos;t be loaded right now. Try again in a moment.
          </div>
        ) : articles.length === 0 ? (
          <p className="muted" data-testid="empty">
            Nothing is published yet.
          </p>
        ) : (
          <ul className="article-list" data-testid="articles">
            {articles.map((a) => (
              <li key={a.slug} className="card" data-testid="article-card">
                <h2>
                  <Link href={`/articles/${a.slug}`}>{a.title}</Link>
                </h2>
                {a.summary ? <p>{a.summary}</p> : null}
                <span className="muted">Published {date(a.publishedAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <Pager after={after} next={page?.next ?? null} base="/" label="Older articles" />
      </main>
    </>
  );
}
