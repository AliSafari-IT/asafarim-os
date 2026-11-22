/**
 * Compare two versions of an article (#372): two revisions by number, the draft head (`head`), or this author's
 * autosave (`autosave`), e.g. `?from=head&to=autosave` after a conflict. Title and summary changes first, then a line
 * diff of the body's plain text (lib/diff.ts). Studio-only like the preview: signed in, allowed to see the article,
 * `private, no-store`, `noindex`.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Notices } from "@/components/Notices";
import { TopBar } from "@/components/TopBar";
import { getAutosave, getRevision, getStudioItem, type StudioItemView } from "@/lib/content";
import { parseBefore } from "@/lib/cursor";
import { db } from "@/lib/db";
import { diffLines, diffStats } from "@/lib/diff";
import type { Actor } from "@/lib/policy";
import { requireStudio } from "@/lib/studio";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Compare revisions", robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
};

interface Side {
  label: string;
  title: string;
  summary: string;
  body: string;
}

async function side(
  pool: Awaited<ReturnType<typeof db>>,
  actor: Actor,
  view: StudioItemView,
  which: string | undefined,
): Promise<Side | null> {
  if (which === "autosave") {
    const a = await getAutosave(pool, actor, view.item.id);
    return a ? { label: `your unsaved text (based on #${a.baseNumber})`, ...a } : null;
  }
  if (which === "head" || which === undefined) {
    const d = view.item.draft;
    return { label: `revision #${d.number} (draft head)`, title: d.title, summary: d.summary, body: d.body };
  }
  const number = parseBefore(which);
  const r = number ? await getRevision(pool, actor, view.item.id, number) : null;
  return r
    ? {
        label: `revision #${r.revision.number}`,
        title: r.revision.title,
        summary: r.revision.summary,
        body: r.revision.body,
      }
    : null;
}

export default async function ComparePage({ params, searchParams }: Props) {
  const { id } = await params;
  const { from, to } = await searchParams;
  const g = await requireStudio();
  if (!g.ok) {
    return (
      <>
        <TopBar next={`/studio/content/${id}`} />
        <main>
          <Notices error={g.error} />
        </main>
      </>
    );
  }
  const pool = await db();
  const view = await getStudioItem(pool, g.actor, id, { limit: 1 });
  if (!view) notFound();
  const [a, b] = await Promise.all([side(pool, g.actor, view, from), side(pool, g.actor, view, to ?? "autosave")]);
  if (!a || !b) notFound();
  const lines = diffLines(a.body, b.body);
  const stats = diffStats(lines);
  return (
    <>
      <TopBar next={`/studio/content/${id}`} />
      <main className="wide">
        <p>
          <Link href={`/studio/content/${id}`}>← Back to the editor</Link>
        </p>
        <h1>Compare</h1>
        <p data-testid="compare-sides">
          From <strong className="diff-removed-label">{a.label}</strong> to{" "}
          <strong className="diff-added-label">{b.label}</strong>:{" "}
          <span data-testid="compare-stats">
            {stats.added} {stats.added === 1 ? "line" : "lines"} added, {stats.removed} removed
          </span>
        </p>
        {a.title !== b.title ? (
          <p data-testid="compare-title">
            Title: <del>{a.title}</del> → <ins>{b.title}</ins>
          </p>
        ) : null}
        {a.summary !== b.summary ? (
          <p data-testid="compare-summary">
            Summary: <del>{a.summary || "(empty)"}</del> → <ins>{b.summary || "(empty)"}</ins>
          </p>
        ) : null}
        <ol className="diff card" data-testid="diff" aria-label="Changes in the body">
          {lines.length === 0 ? <li className="muted">Both bodies are empty.</li> : null}
          {lines.map((l, i) => (
            <li key={i} className={`diff-${l.kind}`} data-kind={l.kind}>
              <span className="diff-sign" aria-hidden="true">
                {l.kind === "added" ? "+" : l.kind === "removed" ? "−" : " "}
              </span>
              <span className="visually-hidden">{l.kind === "same" ? "" : `${l.kind}: `}</span>
              {l.text || " "}
            </li>
          ))}
        </ol>
      </main>
    </>
  );
}
