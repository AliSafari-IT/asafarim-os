"use server";
/**
 * The course studio's mutations (#358). Like app/studio/actions.ts: each one passes the studio gate first, then
 * lib/courses re-checks the course permission against the locked row in the transaction that writes. Every edit
 * names the revision the page showed, so a stale tab can't write over a newer revision.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isUuid } from "@/lib/content";
import {
  createCourse,
  editCourse,
  getStudioCourse,
  publishCourse,
  withdrawCourse,
  type CourseEdit,
  type CourseResult,
} from "@/lib/courses";
import { db } from "@/lib/db";
import { studioGate } from "@/lib/studio";
import { isSlug, parseSlug } from "@/lib/validation";

const field = (f: FormData, name: string) => {
  const v = f.get(name);
  return typeof v === "string" ? v : "";
};

/** The publication state the page showed; anything unreadable never matches, so the change is refused as stale. */
const shownPublication = (f: FormData) => {
  const n = Number(field(f, "publication"));
  return Number.isSafeInteger(n) && n >= 0 ? n : -1;
};

async function actorOrRedirect(back: string) {
  const g = await studioGate();
  if (!g.ok) redirect(g.status === 401 ? "/studio" : `${back}?error=${g.error}`);
  return g.actor;
}

function outcome(back: string, r: CourseResult<object>, done: string): never {
  if (!r.ok) {
    const q = new URLSearchParams({ error: `course_${r.error}` });
    if (r.detail) q.set("detail", r.detail);
    redirect(`${back}?${q}`);
  }
  redirect(`${back}?done=${done}`);
}

/** After publish/withdraw: the public course pages render per request; this drops any cached copy too. */
async function refreshPublic(slug: string) {
  revalidatePath("/courses");
  revalidatePath(`/courses/${slug}`, "layout");
}

export async function createCourseAction(formData: FormData) {
  const actor = await actorOrRedirect("/studio/courses");
  const title = field(formData, "title").trim();
  const slug = parseSlug(field(formData, "slug"), title);
  if (!slug.ok) redirect("/studio/courses?error=course_invalid_slug");
  const r = await createCourse(await db(), actor, { slug: slug.value, title, summary: field(formData, "summary") });
  if (!r.ok) outcome("/studio/courses", r, "");
  redirect(`/studio/courses/${r.id}?done=course_created`);
}

/** Every structural change: the form names the operation and the revision it was rendered from. */
export async function editCourseAction(formData: FormData) {
  const id = field(formData, "id");
  if (!isUuid(id)) redirect("/studio/courses?error=course_not_found");
  const back = `/studio/courses/${id}`;
  const actor = await actorOrRedirect(back);
  const index = (name: string) => Number.parseInt(field(formData, name), 10);
  const lessonId = field(formData, "lesson");
  let edit: CourseEdit;
  switch (field(formData, "op")) {
    case "meta":
      edit = { op: "meta", title: field(formData, "title"), summary: field(formData, "summary") };
      break;
    case "add_module":
      edit = { op: "add_module", title: field(formData, "title") };
      break;
    case "rename_module":
      edit = { op: "rename_module", module: index("module"), title: field(formData, "title") };
      break;
    case "remove_module":
      edit = { op: "remove_module", module: index("module") };
      break;
    case "add_lesson": {
      const article = field(formData, "article").trim().toLowerCase();
      if (!isSlug(article)) redirect(`${back}?error=course_article_not_public`);
      edit = { op: "add_lesson", module: index("module"), articleSlug: article };
      break;
    }
    case "lesson_up":
    case "lesson_down":
      edit = { op: "move_lesson", lessonId, delta: field(formData, "op") === "lesson_up" ? -1 : 1 };
      break;
    case "remove_lesson":
      edit = { op: "remove_lesson", lessonId };
      break;
    case "update_lesson":
      edit = { op: "update_lesson", lessonId };
      break;
    case "cover":
      edit = {
        op: "cover",
        url: field(formData, "source") === "svg" ? "" : field(formData, "url"),
        svg: field(formData, "source") === "svg" ? field(formData, "svg") : "",
        alt: field(formData, "alt"),
      };
      break;
    case "add_card":
      edit = { op: "add_card", front: field(formData, "front"), back: field(formData, "back") };
      break;
    case "edit_card":
      edit = {
        op: "edit_card",
        cardId: field(formData, "card"),
        front: field(formData, "front"),
        back: field(formData, "back"),
      };
      break;
    case "card_up":
    case "card_down":
      edit = { op: "move_card", cardId: field(formData, "card"), delta: field(formData, "op") === "card_up" ? -1 : 1 };
      break;
    case "remove_card":
      edit = { op: "remove_card", cardId: field(formData, "card") };
      break;
    default:
      redirect(`${back}?error=course_unknown_lesson`);
  }
  const r = await editCourse(await db(), actor, { id, expectedRevisionId: field(formData, "revision"), edit });
  // Card changes land back on the cards section (with their notice there), so a long course doesn't scroll the
  // author to the top after each card.
  if (edit.op.endsWith("_card")) {
    const q = new URLSearchParams(r.ok ? { done: "course_card_saved" } : { error: `course_${r.error}` });
    q.set("at", "cards");
    redirect(`${back}?${q}#study-cards`);
  }
  // The cover form is below the course header; land back on it, with its notice there.
  if (edit.op === "cover") {
    const q = new URLSearchParams(r.ok ? { done: "course_saved" } : { error: `course_${r.error}` });
    q.set("at", "cover");
    redirect(`${back}?${q}#cover`);
  }
  outcome(back, r, "course_saved");
}

export async function publishCourseAction(formData: FormData) {
  const id = field(formData, "id");
  if (!isUuid(id)) redirect("/studio/courses?error=course_not_found");
  const back = `/studio/courses/${id}`;
  const actor = await actorOrRedirect(back);
  const pool = await db();
  const r = await publishCourse(pool, actor, {
    id,
    revisionId: field(formData, "revision"),
    publication: shownPublication(formData),
  });
  const course = r.ok ? await getStudioCourse(pool, actor, id) : null;
  if (course) await refreshPublic(course.slug);
  outcome(back, r, "course_published");
}

export async function withdrawCourseAction(formData: FormData) {
  const id = field(formData, "id");
  if (!isUuid(id)) redirect("/studio/courses?error=course_not_found");
  const back = `/studio/courses/${id}`;
  const actor = await actorOrRedirect(back);
  const pool = await db();
  const r = await withdrawCourse(pool, actor, { id, publication: shownPublication(formData) });
  const course = r.ok ? await getStudioCourse(pool, actor, id) : null;
  if (course) await refreshPublic(course.slug);
  outcome(back, r, "course_withdrawn");
}
