/**
 * One article in the studio: the editor on its draft head, its publication state, and the revision
 * history with "Publish this revision" on each. Someone who may not see the article gets a 404, so
 * another author's draft ids reveal nothing.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { changeSlugAction, discardAutosaveAction, publishAction, withdrawAction } from "../../actions";
import { EditorForm } from "@/components/EditorForm";
import { Notices } from "@/components/Notices";
import { TopBar } from "@/components/TopBar";
import { getAutosave, getStudioItem } from "@/lib/content";
import { aiConfigFromEnv } from "@/lib/ai/provider";
import { AI_PERMISSION } from "@/lib/ai/service";
import { db } from "@/lib/db";
import { markdownLosses } from "@/lib/markdown-check";
import { parseBefore } from "@/lib/cursor";
import { canEdit, canPublish } from "@/lib/policy";
import { requireStudio } from "@/lib/studio";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
};

const stamp = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

export default async function StudioItemPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { error, done, before, restore } = await searchParams;
  const g = await requireStudio();
  if (!g.ok) {
    return (
      <>
        <TopBar next="/studio" />
        <main>
          <Notices error={g.error} />
        </main>
      </>
    );
  }
  const pool = await db();
  const found = await getStudioItem(pool, g.actor, id, { before: parseBefore(before) });
  if (!found) notFound();
  // This author's unsaved text from an earlier session (#372), offered back rather than silently loaded.
  const autosave = await getAutosave(pool, g.actor, id);
  const restored = restore === "1" ? autosave : null;
  const { item, revisions, olderBefore, published } = found;
  const editable = canEdit(g.actor, item);
  const publishable = canPublish(g.actor, item);
  const aiEnabled = aiConfigFromEnv() !== null && g.actor.permissions.includes(AI_PERMISSION);
  const losses = item.draft.format === "markdown" ? markdownLosses(item.draft.body) : [];

  return (
    <>
      <TopBar next={`/studio/content/${id}`} />
      <main className="wide">
        <p>
          <Link href="/studio">← Studio</Link>
        </p>
        <h1>{item.draft.title}</h1>
        <Notices error={error} done={done} />

        <section className="card" data-testid="publication">
          <h2>Publication</h2>
          <p>
            Status:{" "}
            <span className={`badge ${item.status}`} data-testid="status">
              {item.status}
            </span>
            {item.status === "published" ? (
              <>
                {" "}
                · revision <strong data-testid="published-number">{published?.number ?? "?"}</strong> at{" "}
                <Link href={`/articles/${item.slug}`}>/articles/{item.slug}</Link>
              </>
            ) : null}
          </p>
          {(item.status === "draft" ? editable : publishable) ? (
            <form action={changeSlugAction} className="inline-form" data-testid="slug-form">
              <input type="hidden" name="id" value={item.id} />
              <label>
                Address{" "}
                <span className="muted">
                  {item.status === "draft"
                    ? "(never published, so no redirect is needed)"
                    : "(the old address will redirect to the new one)"}
                </span>
                <input name="slug" defaultValue={item.slug} maxLength={96} pattern="[a-z0-9]+(-[a-z0-9]+)*" required />
              </label>
              <button type="submit" className="secondary" data-testid="change-slug">
                Change address
              </button>
            </form>
          ) : null}
          <p>
            <Link href={`/studio/content/${item.id}/preview`} data-testid="preview-link">
              Preview the draft
            </Link>{" "}
            <span className="muted">(only you and editors can open it)</span>
          </p>
          {item.status === "published" && publishable ? (
            <form action={withdrawAction}>
              <input type="hidden" name="id" value={item.id} />
              <button type="submit" className="secondary danger" data-testid="withdraw">
                Withdraw from the public site
              </button>
            </form>
          ) : null}
        </section>

        {item.draft.format === "markdown" ? (
          <div className="notice" data-testid="markdown-import">
            This draft was written in Markdown. It opens in the structured editor and becomes a structured revision when
            you save; the Markdown revision itself is kept unchanged.
            {losses.length ? (
              <>
                {" "}
                <strong>Not carried over:</strong> {losses.join(", ")}. Check the text before saving.
              </>
            ) : null}
          </div>
        ) : null}
        {autosave && !restored && editable ? (
          <div className="notice" data-testid="autosave-offer">
            You have unsaved changes from {stamp(autosave.savedAt)} UTC, based on revision #{autosave.baseNumber}
            {autosave.baseRevisionId !== item.draftRevisionId ? (
              <strong> (a newer revision has been saved since: compare before restoring)</strong>
            ) : null}
            .{" "}
            <Link href={`/studio/content/${item.id}?restore=1`} data-testid="autosave-restore">
              Restore them
            </Link>{" "}
            ·{" "}
            <Link
              href={`/studio/content/${item.id}/compare?from=head&to=autosave`}
              data-testid="autosave-compare-offer"
            >
              Compare with the draft
            </Link>
            <form action={discardAutosaveAction} className="inline">
              <input type="hidden" name="id" value={item.id} />
              <button type="submit" className="secondary" data-testid="autosave-discard">
                Discard them
              </button>
            </form>
          </div>
        ) : null}
        <EditorForm
          key={restored ? `${item.id}:restored` : item.id}
          id={item.id}
          // Restored text builds on the revision it was written against, so a save over a newer one is a conflict.
          revisionId={restored ? restored.baseRevisionId : item.draftRevisionId}
          title={restored ? restored.title : item.draft.title}
          summary={restored ? restored.summary : item.draft.summary}
          doc={restored ? restored.doc : item.draft.format === "tiptap" ? item.draft.doc : null}
          markdown={!restored && item.draft.format === "markdown" ? item.draft.body : ""}
          canEdit={editable}
          aiEnabled={aiEnabled}
        />

        <section className="card" data-testid="revisions">
          <h2>Revisions</h2>
          <ol className="revisions" reversed>
            {revisions.map((r) => (
              <li key={r.id} data-testid="revision">
                <span>
                  <strong>#{r.number}</strong> {r.title} <span className="muted">· {stamp(r.createdAt)}</span>
                  {r.id === item.draftRevisionId ? <span className="badge draft">draft head</span> : null}
                  {r.id === item.publishedRevisionId ? <span className="badge published">public</span> : null}
                  <span className="revision-links">
                    <Link href={`/studio/content/${item.id}/preview?rev=${r.number}`}>Preview</Link>
                    {r.number > 1 ? (
                      <Link
                        href={`/studio/content/${item.id}/compare?from=${r.number - 1}&to=${r.number}`}
                        data-testid={`compare-${r.number}`}
                      >
                        Changes
                      </Link>
                    ) : null}
                  </span>
                </span>
                {publishable && r.id !== item.publishedRevisionId ? (
                  <form action={publishAction}>
                    <input type="hidden" name="id" value={item.id} />
                    <input type="hidden" name="revisionId" value={r.id} />
                    <button type="submit" className="secondary" data-testid={`publish-${r.number}`}>
                      Publish this revision
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ol>
          {before || olderBefore ? (
            <nav className="pager" aria-label="Revision pages" data-testid="revision-pager">
              {before ? <Link href={`/studio/content/${item.id}`}>← Newest revisions</Link> : <span />}
              {olderBefore ? (
                <Link href={`/studio/content/${item.id}?before=${olderBefore}`} data-testid="revisions-older">
                  Older revisions →
                </Link>
              ) : null}
            </nav>
          ) : null}
        </section>
      </main>
    </>
  );
}
