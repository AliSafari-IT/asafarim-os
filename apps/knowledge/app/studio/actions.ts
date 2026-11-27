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
  autosaveDraft,
  changeSlug,
  createArticle,
  deleteDraftArticle,
  discardAutosave,
  getStudioItem,
  isUuid,
  publishRevision,
  saveDraft,
  withdrawArticle,
  type Failure,
} from "@/lib/content";
import { db } from "@/lib/db";
import { studioGate } from "@/lib/studio";
import { EMPTY_DOC, parseDoc } from "@/lib/doc";
import { isSlug, parseDraft, parseSlug } from "@/lib/validation";
import { classify, createTag, createTopic, type TagKind } from "@/lib/taxonomy";

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
  // New articles are structured documents from their first revision (#356).
  const r = await createArticle(await db(), actor, { slug: slug.value, draft: { ...draft.value, doc: EMPTY_DOC } });
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
  // The editor sends the document as JSON; it is validated and normalised here, never trusted (lib/doc.ts).
  const doc = parseDoc(field(formData, "doc"));
  if (!doc.ok) return { error: doc.error };
  const draft = parseDraft({ title: field(formData, "title"), summary: field(formData, "summary"), body: doc.text });
  if (!draft.ok) return { error: draft.error };
  draft.value.doc = doc.doc;
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

/** Permanently delete a never-published draft, after the confirmation page (lib/content.ts: deleteDraftArticle). */
export async function deleteArticleAction(formData: FormData) {
  const id = field(formData, "id");
  if (!isUuid(id)) redirect("/studio?error=not_found");
  const back = `/studio/content/${id}/delete`;
  const actor = await actorOrRedirect(back);
  const r = await deleteDraftArticle(await db(), actor, { id });
  // An article that isn't there (or isn't theirs) has no confirmation page to go back to.
  if (!r.ok) fail(r.error === "not_found" ? "/studio" : back, r);
  revalidatePath("/studio");
  redirect("/studio?done=deleted");
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

/** What the editor shows after an autosave: when it was kept, or why not, and a newer revision if one exists. */
export type AutosaveResult =
  { ok: true; savedAt: string; conflict: { revisionId: string } | null } | { ok: false; error: string };

/**
 * Autosave from the editor (#372), called a few seconds after the author stops typing. It keeps the text as this
 * author's autosave of the article, never as a revision, and reports a newer draft head instead of overwriting it.
 */
export async function autosaveAction(input: {
  id: string;
  baseRevisionId: string;
  title: string;
  summary: string;
  doc: string;
}): Promise<AutosaveResult> {
  if (!isUuid(input.id) || typeof input.baseRevisionId !== "string") return { ok: false, error: "not_found" };
  const g = await studioGate();
  if (!g.ok) return { ok: false, error: g.status === 401 ? "unauthenticated" : g.error };
  const doc = parseDoc(typeof input.doc === "string" ? input.doc : "");
  if (!doc.ok) return { ok: false, error: doc.error };
  // An autosave may be untitled for now; a save still requires a title.
  const draft = parseDraft({ title: input.title || "Untitled", summary: input.summary, body: doc.text });
  if (!draft.ok) return { ok: false, error: draft.error };
  const r = await autosaveDraft(await db(), g.actor, {
    id: input.id,
    baseRevisionId: input.baseRevisionId,
    draft: { ...draft.value, title: typeof input.title === "string" ? input.title.trim() : "", doc: doc.doc },
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, savedAt: r.savedAt.toISOString(), conflict: r.conflict ? { revisionId: r.conflict } : null };
}

export async function discardAutosaveAction(formData: FormData) {
  const id = field(formData, "id");
  if (!isUuid(id)) redirect("/studio?error=not_found");
  const back = `/studio/content/${id}`;
  const actor = await actorOrRedirect(back);
  await discardAutosave(await db(), actor, id);
  redirect(`${back}?done=autosave_discarded`);
}

export async function changeSlugAction(formData: FormData) {
  const id = field(formData, "id");
  if (!isUuid(id)) redirect("/studio?error=not_found");
  const back = `/studio/content/${id}`;
  const actor = await actorOrRedirect(back);
  const slug = field(formData, "slug").trim().toLowerCase();
  if (!isSlug(slug)) redirect(`${back}?error=invalid_slug`);
  const r = await changeSlug(await db(), actor, { id, slug });
  if (!r.ok) fail(back, r);
  revalidatePath("/");
  revalidatePath(`/articles/${r.previous}`);
  revalidatePath(`/articles/${r.slug}`);
  redirect(`${back}?done=slug_changed`);
}

/** Classify an article (#357): topic, level and curated tags (comma-separated slugs, names or aliases). */
export async function classifyAction(formData: FormData) {
  const id = field(formData, "id");
  if (!isUuid(id)) redirect("/studio?error=not_found");
  const back = `/studio/content/${id}`;
  const actor = await actorOrRedirect(back);
  const tags = field(formData, "tags")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const r = await classify(await db(), actor, {
    id,
    topicSlug: field(formData, "topic") || null,
    level: field(formData, "level") || null,
    language: field(formData, "language") || undefined,
    tags,
  });
  if (!r.ok) {
    const q = new URLSearchParams({ error: r.error });
    if (r.detail) q.set("detail", r.detail);
    redirect(`${back}?${q}`);
  }
  revalidatePath("/search");
  redirect(`${back}?done=classified`);
}

export async function createTopicAction(formData: FormData) {
  const actor = await actorOrRedirect("/studio/taxonomy");
  const r = await createTopic(await db(), actor, {
    slug: field(formData, "slug").trim().toLowerCase(),
    name: field(formData, "name"),
    description: field(formData, "description"),
    parentSlug: field(formData, "parent") || null,
  });
  if (!r.ok) redirect(`/studio/taxonomy?error=${r.error}`);
  redirect("/studio/taxonomy?done=topic_created");
}

export async function createTagAction(formData: FormData) {
  const actor = await actorOrRedirect("/studio/taxonomy");
  const r = await createTag(await db(), actor, {
    slug: field(formData, "slug").trim().toLowerCase(),
    name: field(formData, "name"),
    kind: (field(formData, "kind") || "subject") as TagKind,
    aliases: field(formData, "aliases").split(","),
  });
  if (!r.ok) {
    const q = new URLSearchParams({ error: r.error });
    if (r.detail) q.set("detail", r.detail);
    redirect(`/studio/taxonomy?${q}`);
  }
  redirect("/studio/taxonomy?done=tag_created");
}
