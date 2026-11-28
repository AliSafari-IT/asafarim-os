/**
 * Playwright's global setup: a fresh `knowledge_e2e` database, migrated and seeded through lib/ exactly as the studio
 * would write it. The guest journey (courses.spec.ts) then reads it through the production build.
 *
 * Seeded: four published articles; a published course "Ship a web app" with three lessons in two modules, plus a
 * fourth lesson whose article is withdrawn after the course was published, and three study cards; then a new draft of the first lesson's
 * article, which the published course must not show. And an article with a YouTube video (#359).
 */
import pg from "pg";
import { createArticle, publishRevision, saveDraft, withdrawArticle } from "../lib/content";
import { COVER_SVG } from "./cover";
import { createCourse, editCourse, publishCourse, type CourseEdit } from "../lib/courses";
import { parseDoc } from "../lib/doc";
import { classify, createTag } from "../lib/taxonomy";
import { migrate } from "../lib/migrations";
import type { Actor } from "../lib/policy";
import { E2E_DATABASE_URL } from "../playwright.config";

const author: Actor = {
  subject: "e2e-author",
  permissions: [
    "knowledge.content.create",
    "knowledge.content.edit.own",
    "knowledge.content.publish.own",
    "knowledge.courses.manage.own",
  ],
};

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`seed step failed: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

export default async function seed() {
  const target = new URL(E2E_DATABASE_URL);
  const adminUrl = new URL(target);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS knowledge_e2e WITH (FORCE)");
  await admin.query("CREATE DATABASE knowledge_e2e");
  await admin.end();

  const pool = new pg.Pool({ connectionString: E2E_DATABASE_URL, max: 2 });
  try {
    const c = await pool.connect();
    await migrate(c).finally(() => c.release());

    const article = async (slug: string, title: string, body: string) => {
      const a = ok(await createArticle(pool, author, { slug, draft: { title, summary: "", body } }));
      ok(await publishRevision(pool, author, { id: a.id, revisionId: a.revisionId }));
      return a;
    };
    const plan = await article("plan-the-app", "Plan the app", "Write down what the app must do.");
    await article("build-the-api", "Build the API", "Expose the data over HTTP.");
    await article("deploy-it", "Deploy it", "Ship the container to the server.");
    const extra = await article("bonus-tuning", "Bonus: tuning", "Make it fast.");

    const editor = { ...author, permissions: [...author.permissions, "knowledge.taxonomy.manage"] };
    ok(await createTag(pool, editor, { slug: "planning", name: "Planning", kind: "subject", aliases: ["plans"] }));
    ok(await createTag(pool, editor, { slug: "tuning", name: "Tuning", kind: "subject" }));
    ok(await classify(pool, author, { id: plan.id, topicSlug: null, level: null, tags: ["plans"] }));
    ok(await classify(pool, author, { id: extra.id, topicSlug: null, level: null, tags: ["tuning"] }));

    const course = ok(
      await createCourse(pool, author, {
        slug: "ship-a-web-app",
        title: "Ship a web app",
        summary: "Plan, build, ship.",
      }),
    );
    let rev = course.revisionId;
    const edits: CourseEdit[] = [
      { op: "add_module", title: "Design" },
      { op: "add_lesson", module: 0, articleSlug: "plan-the-app" },
      { op: "add_module", title: "Delivery" },
      { op: "add_lesson", module: 1, articleSlug: "build-the-api" },
      { op: "add_lesson", module: 1, articleSlug: "deploy-it" },
      { op: "add_lesson", module: 1, articleSlug: "bonus-tuning" },
      { op: "cover", url: "", svg: COVER_SVG, alt: "A rocket over a browser window" },
      { op: "add_card", front: "What does a course lesson pin?", back: "One published revision of its article." },
      {
        op: "add_card",
        front: "When do guests see a course change?",
        back: "Only after the course is published again.",
      },
      {
        op: "add_card",
        front: "Where is a learner's progress kept?",
        back: "In their own browser,\nnot on the server.",
      },
    ];
    for (const edit of edits) {
      rev = ok(await editCourse(pool, author, { id: course.id, expectedRevisionId: rev, edit })).revisionId;
    }
    ok(await publishCourse(pool, author, { id: course.id, revisionId: rev, publication: 0 }));

    // After publication: one lesson's article is withdrawn, another's gets a new (unpublished) draft.
    ok(await withdrawArticle(pool, author, { id: extra.id }));
    ok(
      await saveDraft(pool, author, {
        id: plan.id,
        expectedRevisionId: plan.revisionId,
        draft: { title: "Plan the app (rewritten)", summary: "", body: "A draft nobody may see yet." },
      }),
    );

    // #359: an article with a video, which a guest loads only on request.
    const video = parseDoc({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Watch the demo." }] },
        { type: "video", attrs: { provider: "youtube", videoId: "dQw4w9WgXcQ", title: "The demo" } },
      ],
    });
    if (!video.ok) throw new Error(video.error);
    const demo = ok(
      await createArticle(pool, author, {
        slug: "video-demo",
        draft: { title: "Video demo", summary: "", body: video.text, doc: video.doc },
      }),
    );
    ok(await publishRevision(pool, author, { id: demo.id, revisionId: demo.revisionId }));
  } finally {
    await pool.end();
  }
}
