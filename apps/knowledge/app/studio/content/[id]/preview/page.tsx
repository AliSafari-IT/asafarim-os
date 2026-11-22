/**
 * The authenticated preview (#372): one revision of an article (the draft head by default, or `?rev=<number>`)
 * rendered exactly as the public page would render it. It lives under /studio, so the gateway asks for a sign-in,
 * the page checks the person may see the article (a 404 otherwise), and next.config.ts answers it `private,
 * no-store` with `noindex`. Nothing here is reachable by a guest.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DocView } from "@/components/DocView";
import { Markdown } from "@/components/Markdown";
import { Notices } from "@/components/Notices";
import { TopBar } from "@/components/TopBar";
import { getRevision, getStudioItem } from "@/lib/content";
import { parseBefore } from "@/lib/cursor";
import { db } from "@/lib/db";
import { parseDoc } from "@/lib/doc";
import { requireStudio } from "@/lib/studio";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Preview", robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
};

export default async function PreviewPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { rev } = await searchParams;
  const g = await requireStudio();
  if (!g.ok) {
    return (
      <>
        <TopBar next={`/studio/content/${id}/preview`} />
        <main>
          <Notices error={g.error} />
        </main>
      </>
    );
  }
  const pool = await db();
  const number = parseBefore(rev);
  const found = number
    ? await getRevision(pool, g.actor, id, number)
    : await getStudioItem(pool, g.actor, id, { limit: 1 }).then((v) =>
        v ? { item: v.item, revision: v.item.draft } : null,
      );
  if (!found) notFound();
  const { item, revision } = found;
  const parsed = revision.format === "tiptap" && revision.doc ? parseDoc(revision.doc) : null;
  const doc = parsed?.ok ? parsed.doc : null;
  const role =
    revision.id === item.publishedRevisionId
      ? "the public revision"
      : revision.id === item.draftRevisionId
        ? "the draft head, not public"
        : "an earlier revision, not public";
  return (
    <>
      <TopBar next={`/studio/content/${id}/preview`} />
      <main>
        <div className="notice" data-testid="preview-banner">
          Preview of revision <strong>#{revision.number}</strong> ({role}), as it would appear at{" "}
          {`/articles/${item.slug}`}. <Link href={`/studio/content/${item.id}`}>Back to the editor</Link>
        </div>
        <article data-testid="article">
          <h1>{revision.title}</h1>
          {revision.summary ? <p className="lead">{revision.summary}</p> : null}
          {revision.format === "tiptap" && doc ? <DocView doc={doc} /> : <Markdown markdown={revision.body} />}
        </article>
      </main>
    </>
  );
}
