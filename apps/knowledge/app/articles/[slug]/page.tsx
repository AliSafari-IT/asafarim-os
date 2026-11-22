/**
 * One published article, for anyone. A slug with no published revision (a draft, a withdrawn article
 * or no such article) is a 404: a guest can't tell those cases apart. An old address of a published article
 * (#372) answers a permanent redirect to its current one; an old address of an unpublished one is the same 404.
 */
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { DocView } from "@/components/DocView";
import { Markdown } from "@/components/Markdown";
import { TopBar } from "@/components/TopBar";
import { getPublishedArticle, resolveSlugRedirect } from "@/lib/content";
import { parseDoc } from "@/lib/doc";
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
  if (!article) {
    const moved = isSlug(slug) ? await resolveSlugRedirect(await db(), slug) : null;
    if (moved) permanentRedirect(`/articles/${moved}`);
    notFound();
  }
  // Validated again on the way out: the page renders only what lib/doc.ts accepts, whatever is in the database.
  const parsed = article.doc ? parseDoc(article.doc) : null;
  const doc = parsed?.ok ? parsed.doc : null;
  return (
    <>
      <TopBar next={`/articles/${slug}`} />
      <main>
        <article data-testid="article">
          <h1>{article.title}</h1>
          <p className="muted">Published {article.publishedAt.toISOString().slice(0, 10)}</p>
          {article.summary ? <p className="lead">{article.summary}</p> : null}
          {article.format === "tiptap" && doc ? <DocView doc={doc} /> : <Markdown markdown={article.body} />}
        </article>
      </main>
    </>
  );
}
