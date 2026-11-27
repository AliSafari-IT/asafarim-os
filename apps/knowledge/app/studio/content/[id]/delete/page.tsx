/**
 * Confirm deleting a never-published draft. A page, not a browser dialog: opening it changes nothing, and the one
 * button posts to deleteArticleAction, which checks everything again on the server (who may edit it, that it was
 * never published, that it is in no course). Someone who may not see the article gets a 404, like the editor.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteArticleAction } from "../../../actions";
import { Notices } from "@/components/Notices";
import { TopBar } from "@/components/TopBar";
import { getStudioItem } from "@/lib/content";
import { db } from "@/lib/db";
import { one, type SearchParams } from "@/lib/params";
import { canEdit } from "@/lib/policy";
import { requireStudio } from "@/lib/studio";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Delete draft", robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
};

export default async function DeleteDraftPage({ params, searchParams }: Props) {
  const { id } = await params;
  const error = one((await searchParams).error);
  const g = await requireStudio();
  if (!g.ok) {
    return (
      <>
        <TopBar next={`/studio/content/${id}/delete`} />
        <main>
          <Notices error={g.error} />
        </main>
      </>
    );
  }
  const found = await getStudioItem(await db(), g.actor, id, { limit: 1 });
  if (!found) notFound();
  const { item } = found;
  const mayEdit = canEdit(g.actor, item);
  const deletable = mayEdit && item.status === "draft";
  const editorHref = `/studio/content/${item.id}`;
  // Revision numbers run 1..n without gaps, so the head's number is how many are saved.
  const revisions = item.draft.number;

  return (
    <>
      <TopBar next={`/studio/content/${id}/delete`} />
      <main>
        <p>
          <Link href={editorHref}>← Back to the article</Link>
        </p>
        <h1>Delete this draft?</h1>
        <Notices error={error} />
        <section className="card" data-testid="delete-draft">
          <h2>{item.draft.title}</h2>
          {deletable ? (
            <>
              <p>
                This permanently deletes the draft, its {revisions} saved {revisions === 1 ? "revision" : "revisions"}{" "}
                and any unsaved changes. It can&apos;t be undone.
              </p>
              <p className="muted">
                Files you uploaded stay in Media, and the audit log keeps a record that it was deleted. Its address
                becomes free to use again.
              </p>
              <form action={deleteArticleAction} className="actions confirm-actions">
                <input type="hidden" name="id" value={item.id} />
                <button type="submit" className="danger-solid" data-testid="confirm-delete">
                  Delete permanently
                </button>
                <Link href={editorHref} data-testid="cancel-delete">
                  Cancel
                </Link>
              </form>
            </>
          ) : (
            <>
              <p data-testid="not-deletable">
                {mayEdit
                  ? "This article has been public, so it can't be deleted. Withdraw it from the public site instead; it stays in the studio."
                  : "You don't have permission to delete this article."}
              </p>
              <p>
                <Link href={editorHref}>Back to the article</Link>
              </p>
            </>
          )}
        </section>
      </main>
    </>
  );
}
