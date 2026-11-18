/**
 * One published article, for anyone. A slug with no published revision (a draft, a withdrawn article
 * or no such article) is a 404: a guest can't tell those cases apart.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/Markdown";
import { TopBar } from "@/components/TopBar";
import { getPublishedArticle } from "@/lib/content";
import { db } from "@/lib/db";
import { isSlug } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

async function load(slug: string) {
  return isSlug(slug) ? getPublishedArticle(await db(), slug) : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const article = await load((await params).slug);
  return article ? { title: article.title, description: article.summary || undefined } : {};
}

export default async function ArticlePage({ params }: Props) {
  const { slug } = await params;
  const article = await load(slug);
  if (!article) notFound();
  return (
    <>
      <TopBar next={`/articles/${slug}`} />
      <main>
        <article data-testid="article">
          <h1>{article.title}</h1>
          <p className="muted">Published {article.publishedAt.toISOString().slice(0, 10)}</p>
          {article.summary ? <p className="lead">{article.summary}</p> : null}
          <Markdown markdown={article.body} />
        </article>
      </main>
    </>
  );
}
