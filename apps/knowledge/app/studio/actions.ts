"use server";
/**
 * The studio's mutations. Each one passes the studio gate (signed in, app active,
 * knowledge.content.create), validates its input, and lets lib/content re-check ownership and the
 * publish permission against the locked row in the same transaction that writes. Next.js checks the
 * Origin of every server action, so a cross-site form can't post here.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createArticle,
  getStudioItem,
  isUuid,
  publishRevision,
  saveDraft,
  withdrawArticle,
  type Failure,
} from "@/lib/content";
import { db } from "@/lib/db";
import { studioGate } from "@/lib/studio";
import { parseDraft, parseSlug } from "@/lib/validation";

const field = (f: FormData, name: string) => {
  const v = f.get(name);
  return typeof v === "string" ? v : "";
};

async function actorOrRedirect(back: string) {
  const g = await studioGate();
  if (!g.ok) redirect(g.status === 401 ? "/studio" : `${back}?error=${g.error}`);
  return g.actor;
}

function fail(back: string, f: Failure): never {
  const q = new URLSearchParams({ error: f.error });
  if (f.error === "conflict") q.set("current", f.currentRevisionId);
  redirect(`${back}?${q}`);
}

/** After publish/withdraw: the public pages render per request; this drops any cached copy too. */
async function refreshPublic(id: string) {
  revalidatePath("/");
  const actor = await studioGate();
  if (!actor.ok) return;
  const found = await getStudioItem(await db(), actor.actor, id);
  if (found) revalidatePath(`/articles/${found.item.slug}`);
}

export async function createArticleAction(formData: FormData) {
  const actor = await actorOrRedirect("/studio");
  const draft = parseDraft({ title: field(formData, "title"), summary: field(formData, "summary"), body: "" });
  if (!draft.ok) redirect(`/studio?error=${draft.error}`);
  const slug = parseSlug(field(formData, "slug"), draft.value.title);
  if (!slug.ok) redirect(`/studio?error=${slug.error}`);
  const r = await createArticle(await db(), actor, { slug: slug.value, draft: draft.value });
  if (!r.ok) fail("/studio", r);
  revalidatePath("/studio");
  redirect(`/studio/content/${r.id}?done=created`);
}

/** What the editor form keeps between attempts: the outcome of the last save that didn't redirect. */
export interface SaveState {
  error?: string;
  /** On a conflict: the newer revision someone else saved, which the next save will build on. */
  currentRevisionId?: string;
}

/**
 * Save from the editor (useActionState in components/EditorForm.tsx). On success it redirects; on a
 * failure it returns, so the author's text stays in the form and nothing is lost, a conflict included.
 */
export async function saveDraftAction(_prev: SaveState, formData: FormData): Promise<SaveState> {
  const id = field(formData, "id");
  if (!isUuid(id)) return { error: "not_found" };
  const back = `/studio/content/${id}`;
  const g = await studioGate();
  if (!g.ok) return { error: g.status === 401 ? "unauthenticated" : g.error };
  const draft = parseDraft({
    title: field(formData, "title"),
    summary: field(formData, "summary"),
    body: field(formData, "body"),
  });
  if (!draft.ok) return { error: draft.error };
  const r = await saveDraft(await db(), g.actor, {
    id,
    expectedRevisionId: field(formData, "expectedRevisionId"),
    draft: draft.value,
  });
  if (!r.ok) {
    // The revision list on the page refreshes, so the newer revision shows next to the author's text.
    if (r.error === "conflict") revalidatePath(back);
    return r.error === "conflict" ? { error: r.error, currentRevisionId: r.currentRevisionId } : { error: r.error };
  }
  revalidatePath(back);
  redirect(`${back}?done=saved`);
}

export async function publishAction(formData: FormData) {
  const id = field(formData, "id");
  if (!isUuid(id)) redirect("/studio?error=not_found");
  const back = `/studio/content/${id}`;
  const actor = await actorOrRedirect(back);
  const r = await publishRevision(await db(), actor, { id, revisionId: field(formData, "revisionId") });
  if (!r.ok) fail(back, r);
  await refreshPublic(id);
  redirect(`${back}?done=published`);
}

export async function withdrawAction(formData: FormData) {
  const id = field(formData, "id");
  if (!isUuid(id)) redirect("/studio?error=not_found");
  const back = `/studio/content/${id}`;
  const actor = await actorOrRedirect(back);
  const r = await withdrawArticle(await db(), actor, { id });
  if (!r.ok) fail(back, r);
  await refreshPublic(id);
  redirect(`${back}?done=withdrawn`);
}
