/**
 * Playwright's global setup: a fresh `knowledge_e2e` database, migrated and seeded through lib/ exactly as the studio
 * would write it. The guest journey (courses.spec.ts) then reads it through the production build.
 *
 * Seeded: four published articles; a published course "Ship a web app" with three lessons in two modules, plus a
 * fourth lesson whose article is withdrawn after the course was published; then a new draft of the first lesson's
 * article, which the published course must not show.
 */
import pg from "pg";
import { createArticle, publishRevision, saveDraft, withdrawArticle } from "../lib/content";
import { createCourse, editCourse, publishCourse, type CourseEdit } from "../lib/courses";
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
    ];
    for (const edit of edits) {
      rev = ok(await editCourse(pool, author, { id: course.id, expectedRevisionId: rev, edit })).revisionId;
    }
    ok(await publishCourse(pool, author, { id: course.id, revisionId: rev }));

    // After publication: one lesson's article is withdrawn, another's gets a new (unpublished) draft.
    ok(await withdrawArticle(pool, author, { id: extra.id }));
    ok(
      await saveDraft(pool, author, {
        id: plan.id,
        expectedRevisionId: plan.revisionId,
        draft: { title: "Plan the app (rewritten)", summary: "", body: "A draft nobody may see yet." },
      }),
    );
  } finally {
    await pool.end();
  }
}
