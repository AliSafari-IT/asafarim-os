/**
 * One published article, for anyone. A slug with no published revision (a draft, a withdrawn article
 * or no such article) is a 404: a guest can't tell those cases apart. An old address of a published article
 * (#372) answers a permanent redirect to its current one; an old address of an unpublished one is the same 404.
 *
 * Under the title: who wrote it, when, and how long it takes to read, then ways to share it. Its metadata
 * (canonical address, Open Graph and Twitter card, and the generated image beside this file) is what LinkedIn, X
 * and messaging apps show when the link is shared.
 */
import { ArticleEngagement } from "@/components/ArticleEngagement";
import { engagementEnabled } from "@/lib/engagement-config";
import { articleCounts, countsOf } from "@/lib/engagement-rollups";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { ArticleByline } from "@/components/ArticleByline";
import { DocView } from "@/components/DocView";
import { Markdown } from "@/components/Markdown";
import { ShareBar } from "@/components/ShareBar";
import { TopBar } from "@/components/TopBar";
import { viewKey } from "@/lib/analytics/classify";
import { recordPageView } from "@/lib/analytics/server";
import { getPublishedArticle, resolveSlugRedirect } from "@/lib/content";
import { parseDoc } from "@/lib/doc";
import { feedAlternates } from "@/lib/feed";
import { db } from "@/lib/db";
import { articleUrl } from "@/lib/site";
import { isSlug } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

async function load(slug: string) {
  return isSlug(slug) ? getPublishedArticle(await db(), slug) : null;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const article = await load(slug);
  if (!article) return {};
  const url = articleUrl(article.slug);
  const description = article.summary || undefined;
  return {
    title: article.title,
    description,
    alternates: { canonical: url, types: feedAlternates() },
    openGraph: {
      type: "article",
      url,
      title: article.title,
      description,
      siteName: "ASafariM Knowledge",
      publishedTime: article.publishedAt.toISOString(),
      authors: article.authorName ? [article.authorName] : undefined,
    },
    twitter: { card: "summary_large_image", title: article.title, description },
  };
}

export default async function ArticlePage({ params }: Props) {
  const { slug } = await params;
  const article = await load(slug);
  if (!article) {
    const moved = isSlug(slug) ? await resolveSlugRedirect(await db(), slug) : null;
    if (moved) permanentRedirect(`/articles/${moved}`);
    notFound();
  }
  await recordPageView(viewKey.article(article.slug));
  // Validated again on the way out: the page renders only what lib/doc.ts accepts, whatever is in the database.
  const parsed = article.doc ? parseDoc(article.doc) : null;
  const doc = parsed?.ok ? parsed.doc : null;
  const url = articleUrl(article.slug);
  const counts = engagementEnabled() ? countsOf(await articleCounts(await db(), [article.id]), article.id) : null;
  return (
    <>
      <TopBar next={`/articles/${slug}`} />
      <main className="article-page">
        <article data-testid="article">
          <header className="article-head">
            {article.topic || article.level ? (
              <p className="chips">
                {article.topic ? (
                  <Link href={`/topics/${article.topic.slug}`} className="chip">
                    {article.topic.name}
                  </Link>
                ) : null}
                {article.level ? <span className="chip level">{capitalise(article.level)}</span> : null}
              </p>
            ) : null}
            <h1>{article.title}</h1>
            {article.summary ? <p className="lead">{article.summary}</p> : null}
            <ArticleByline
              authorName={article.authorName}
              publishedAt={article.publishedAt}
              readingMinutes={article.readingMinutes}
            />
            <ShareBar url={url} title={article.title} slug={article.slug} />
          </header>
          {article.format === "tiptap" && doc ? <DocView doc={doc} /> : <Markdown markdown={article.body} />}
        </article>
        <footer className="article-foot">
          <ShareBar url={url} title={article.title} slug={article.slug} heading="Found this useful? Share it" />
          {counts ? <ArticleEngagement id={article.id} next={`/articles/${article.slug}`} counts={counts} /> : null}
          <p>
            <Link href="/">← All articles</Link>
          </p>
        </footer>
      </main>
    </>
  );
}
