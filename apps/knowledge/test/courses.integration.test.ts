/**
 * Courses on a real PostgreSQL (#358): pinning, eligibility, publish rules and the public reads.
 * Runs when KNOWLEDGE_TEST_DATABASE_URL names a server where it may create a throwaway database.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../platform.app";
import { createArticle, publishRevision, saveDraft, withdrawArticle } from "../lib/content";
import {
  createCourse,
  editCourse,
  getPublishedCards,
  coverSrc,
  getPublishedCourse,
  getPublishedLesson,
  getStudioCourse,
  listPublishedCourses,
  listStudioCourses,
  publishCourse,
  withdrawCourse,
  type CourseEdit,
} from "../lib/courses";
import { migrate } from "../lib/migrations";
import type { Actor } from "../lib/policy";

const ADMIN_URL = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const grants = (role: string) => manifest.roles.find((r) => r.key === role)!.grants;
const alice: Actor = { subject: "alice", permissions: grants("knowledge.author") };
const bob: Actor = { subject: "bob", permissions: grants("knowledge.author") };
const erin: Actor = { subject: "erin", permissions: grants("knowledge.editor") };

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

const draft = (title: string, body: string) => ({ title, summary: "", body });

describe.skipIf(!ADMIN_URL)("courses on PostgreSQL", () => {
  const dbName = `knowledge_courses_${randomBytes(6).toString("hex")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  const articles: Record<string, { id: string; revisionId: string }> = {};

  async function article(slug: string, title: string, body: string, publish = true) {
    const a = ok(await createArticle(pool, alice, { slug, draft: draft(title, body) }));
    if (publish) ok(await publishRevision(pool, alice, { id: a.id, revisionId: a.revisionId }));
    articles[slug] = a;
    return a;
  }

  /** Apply edits in order, each on the revision the previous one wrote. */
  async function edit(actor: Actor, id: string, edits: CourseEdit[]) {
    let rev = (await getStudioCourse(pool, actor, id))!.draftRevisionId;
    for (const e of edits) rev = ok(await editCourse(pool, actor, { id, expectedRevisionId: rev, edit: e })).revisionId;
    return rev;
  }

  /** The publication state a studio page would show now. */
  const shown = async (actor: Actor, id: string) => (await getStudioCourse(pool, actor, id))!.publication;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    pool.on("error", () => undefined);
    const c = await pool.connect();
    try {
      await migrate(c);
    } finally {
      c.release();
    }
    await article("intro", "Introduction", "Welcome to the course.");
    await article("setup", "Setting up", "Install the tools.");
    await article("first-app", "Your first app", "Write the code.");
    await article("unfinished", "Unfinished", "Not yet public.", false);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it("an author publishes a three-lesson course from their published articles", async () => {
    const c = ok(await createCourse(pool, alice, { slug: "getting-started", title: "Getting started" }));
    expect(await createCourse(pool, bob, { slug: "getting-started", title: "Again" })).toEqual({
      ok: false,
      error: "slug_taken",
    });
    const rev = await edit(alice, c.id, [
      { op: "add_module", title: "Basics" },
      { op: "add_lesson", module: 0, articleSlug: "intro" },
      { op: "add_lesson", module: 0, articleSlug: "setup" },
      { op: "add_module", title: "Building" },
      { op: "add_lesson", module: 1, articleSlug: "first-app" },
      { op: "meta", title: "Getting started", summary: "From zero to an app" },
    ]);
    // Nothing public before it is published.
    expect(await getPublishedCourse(pool, "getting-started")).toBeNull();
    ok(await publishCourse(pool, alice, { id: c.id, revisionId: rev, publication: await shown(alice, c.id) }));

    const course = (await getPublishedCourse(pool, "getting-started"))!;
    expect(course.summary).toBe("From zero to an app");
    expect(course.modules.map((m) => [m.title, m.lessons.map((l) => l.title)])).toEqual([
      ["Basics", ["Introduction", "Setting up"]],
      ["Building", ["Your first app"]],
    ]);
    const [first, second, third] = course.modules.flatMap((m) => m.lessons);
    const lesson = (await getPublishedLesson(pool, "getting-started", second!.lessonId))!;
    expect(lesson.body).toBe("Install the tools.");
    expect(lesson.articleSlug).toBe("setup");
    expect(lesson.moduleTitle).toBe("Basics");
    expect(lesson.prev?.lessonId).toBe(first!.lessonId);
    expect(lesson.next?.lessonId).toBe(third!.lessonId);
    expect((await listPublishedCourses(pool)).items.map((s) => [s.slug, s.lessons])).toEqual([["getting-started", 3]]);
  });

  it("keeps published course content when a referenced article gets a new draft or revision", async () => {
    const c = (await listStudioCourses(pool, alice)).items.find((s) => s.slug === "getting-started")!;
    const setup = articles.setup!;
    const v2 = ok(
      await saveDraft(pool, alice, {
        id: setup.id,
        expectedRevisionId: setup.revisionId,
        draft: draft("Setting up (v2)", "Install the new tools."),
      }),
    );
    const lessonId = (await getPublishedCourse(pool, "getting-started"))!.modules[0]!.lessons[1]!.lessonId;
    expect((await getPublishedLesson(pool, "getting-started", lessonId))!.body).toBe("Install the tools.");
    // Even once the article publishes v2, the course still shows the revision it pinned...
    ok(await publishRevision(pool, alice, { id: setup.id, revisionId: v2.revisionId }));
    expect((await getPublishedLesson(pool, "getting-started", lessonId))!.title).toBe("Setting up");
    const studio = (await getStudioCourse(pool, alice, c.id))!;
    expect(studio.modules[0]!.lessons[1]!.state).toBe("outdated");
    // ...until its author updates the lesson to the latest and publishes the course again.
    const rev = await edit(alice, c.id, [{ op: "update_lesson", lessonId }]);
    expect((await getPublishedLesson(pool, "getting-started", lessonId))!.title).toBe("Setting up");
    // The studio says guests still see the published version, and how many lessons it has.
    const pending = (await getStudioCourse(pool, alice, c.id))!;
    expect([pending.draftIsPublished, pending.publishedLessons]).toEqual([false, 3]);
    ok(await publishCourse(pool, alice, { id: c.id, revisionId: rev, publication: await shown(alice, c.id) }));
    const after = (await getPublishedLesson(pool, "getting-started", lessonId))!;
    expect([after.title, after.body]).toEqual(["Setting up (v2)", "Install the new tools."]);
  });

  it("hides a lesson whose article is withdrawn from guests and blocks publishing the course", async () => {
    const c = (await listStudioCourses(pool, alice)).items.find((s) => s.slug === "getting-started")!;
    const lessonId = (await getPublishedCourse(pool, "getting-started"))!.modules[1]!.lessons[0]!.lessonId;
    ok(await withdrawArticle(pool, alice, { id: articles["first-app"]!.id }));

    const course = (await getPublishedCourse(pool, "getting-started"))!;
    expect(course.modules.map((m) => m.title)).toEqual(["Basics"]);
    expect(await getPublishedLesson(pool, "getting-started", lessonId)).toBeNull();
    // The lesson before it no longer links to it.
    expect((await getPublishedLesson(pool, "getting-started", course.modules[0]!.lessons[1]!.lessonId))!.next).toBe(
      null,
    );
    expect((await listPublishedCourses(pool)).items[0]!.lessons).toBe(2);

    const studio = (await getStudioCourse(pool, alice, c.id))!;
    expect(studio.modules[1]!.lessons[0]!.state).toBe("unavailable");
    expect(
      await publishCourse(pool, alice, {
        id: c.id,
        revisionId: studio.draftRevisionId,
        publication: await shown(alice, c.id),
      }),
    ).toEqual({
      ok: false,
      error: "lesson_unavailable",
      detail: "Your first app",
    });
    // It can't be updated to a revision that isn't public either; removing it makes the course publishable.
    expect(
      await editCourse(pool, alice, {
        id: c.id,
        expectedRevisionId: studio.draftRevisionId,
        edit: { op: "update_lesson", lessonId },
      }),
    ).toEqual({ ok: false, error: "article_not_public" });
    const rev = await edit(alice, c.id, [{ op: "remove_lesson", lessonId }]);
    ok(await publishCourse(pool, alice, { id: c.id, revisionId: rev, publication: await shown(alice, c.id) }));
  });

  it("pins only public articles, refuses empty courses, stale editors and other people's courses", async () => {
    const c = ok(await createCourse(pool, bob, { slug: "bobs-course", title: "Bob's course" }));
    const rev0 = (await getStudioCourse(pool, bob, c.id))!.draftRevisionId;
    expect(await publishCourse(pool, bob, { id: c.id, revisionId: rev0, publication: await shown(bob, c.id) })).toEqual(
      {
        ok: false,
        error: "empty_course",
      },
    );
    const rev1 = await edit(bob, c.id, [{ op: "add_module", title: "One" }]);
    expect(
      await editCourse(pool, bob, {
        id: c.id,
        expectedRevisionId: rev1,
        edit: { op: "add_lesson", module: 0, articleSlug: "unfinished" },
      }),
    ).toEqual({ ok: false, error: "article_not_public" });
    expect(
      await editCourse(pool, bob, {
        id: c.id,
        expectedRevisionId: rev1,
        edit: { op: "add_lesson", module: 3, articleSlug: "intro" },
      }),
    ).toEqual({ ok: false, error: "unknown_module" });
    // An editor opened on an older revision can't write over a newer one.
    expect(
      await editCourse(pool, bob, { id: c.id, expectedRevisionId: rev0, edit: { op: "add_module", title: "Two" } }),
    ).toEqual({ ok: false, error: "conflict" });
    // Alice can neither see nor change Bob's course; an editor can.
    expect(await getStudioCourse(pool, alice, c.id)).toBeNull();
    expect(
      await editCourse(pool, alice, { id: c.id, expectedRevisionId: rev1, edit: { op: "add_module", title: "X" } }),
    ).toEqual({ ok: false, error: "not_found" });
    expect((await listStudioCourses(pool, alice)).items.map((s) => s.slug)).toEqual(["getting-started"]);
    expect((await listStudioCourses(pool, erin)).items.length).toBe(2);
    const reader: Actor = { subject: "rita", permissions: ["knowledge.content.create"] };
    expect(await createCourse(pool, reader, { slug: "nope", title: "Nope" })).toEqual({
      ok: false,
      error: "forbidden",
    });
    // A pin can't be forged to a revision the article never published.
    const draftOnly = ok(
      await saveDraft(pool, alice, {
        id: articles.intro!.id,
        expectedRevisionId: articles.intro!.revisionId,
        draft: draft("Intro draft", "Not public"),
      }),
    );
    await expect(pool.query("UPDATE course_lessons SET item_revision_id = $1", [draftOnly.revisionId])).rejects.toThrow(
      /immutable/,
    );
  });

  it("moves lessons within and across modules, and withdraws a course", async () => {
    const c = ok(await createCourse(pool, erin, { slug: "ordering", title: "Ordering" }));
    await edit(erin, c.id, [
      { op: "add_module", title: "A" },
      { op: "add_module", title: "B" },
      { op: "add_lesson", module: 0, articleSlug: "intro" },
      { op: "add_lesson", module: 0, articleSlug: "setup" },
    ]);
    const titles = async () =>
      (await getStudioCourse(pool, erin, c.id))!.modules.map((m) => m.lessons.map((l) => l.articleSlug));
    const id = (slug: string) =>
      getStudioCourse(pool, erin, c.id).then(
        (s) => s!.modules.flatMap((m) => m.lessons).find((l) => l.articleSlug === slug)!.lessonId,
      );
    await edit(erin, c.id, [{ op: "move_lesson", lessonId: await id("setup"), delta: -1 }]);
    expect(await titles()).toEqual([["setup", "intro"], []]);
    await edit(erin, c.id, [{ op: "move_lesson", lessonId: await id("intro"), delta: 1 }]);
    expect(await titles()).toEqual([["setup"], ["intro"]]);
    const rev = await edit(erin, c.id, [{ op: "move_lesson", lessonId: await id("intro"), delta: -1 }]);
    expect(await titles()).toEqual([["setup", "intro"], []]);

    ok(await publishCourse(pool, erin, { id: c.id, revisionId: rev, publication: await shown(erin, c.id) }));
    expect(await getPublishedCourse(pool, "ordering")).not.toBeNull();
    ok(await withdrawCourse(pool, erin, { id: c.id, publication: await shown(erin, c.id) }));
    expect(await getPublishedCourse(pool, "ordering")).toBeNull();
    expect((await getStudioCourse(pool, erin, c.id))!.status).toBe("withdrawn");
  });

  it("refuses publish and withdraw forms from a tab that missed a publication change", async () => {
    const c = ok(await createCourse(pool, erin, { slug: "two-tabs", title: "Two tabs" }));
    const rev1 = await edit(erin, c.id, [
      { op: "add_module", title: "A" },
      { op: "add_lesson", module: 0, articleSlug: "intro" },
    ]);
    ok(await publishCourse(pool, erin, { id: c.id, revisionId: rev1, publication: await shown(erin, c.id) }));
    const rev2 = await edit(erin, c.id, [{ op: "meta", title: "Two tabs, v2", summary: "" }]);
    // Both tabs show revision 2 as an unpublished draft of a published course.
    const tab = await shown(erin, c.id);
    ok(await withdrawCourse(pool, erin, { id: c.id, publication: tab }));
    // The other tab's Publish must not bring back the course the first tab just took offline...
    expect(await publishCourse(pool, erin, { id: c.id, revisionId: rev2, publication: tab })).toEqual({
      ok: false,
      error: "conflict",
    });
    expect(await getPublishedCourse(pool, "two-tabs")).toBeNull();
    // ...and after a full withdraw/publish cycle, an old Withdraw form can't take the new publication offline.
    const before = await shown(erin, c.id);
    ok(await publishCourse(pool, erin, { id: c.id, revisionId: rev2, publication: before }));
    expect(await withdrawCourse(pool, erin, { id: c.id, publication: before })).toEqual({
      ok: false,
      error: "conflict",
    });
    expect((await getPublishedCourse(pool, "two-tabs"))!.title).toBe("Two tabs, v2");
  });

  it("keeps study cards with the course revision: guests see the published cards until the next publish", async () => {
    const c = ok(await createCourse(pool, erin, { slug: "flash", title: "Flash" }));
    const rev = await edit(erin, c.id, [
      { op: "add_module", title: "A" },
      { op: "add_lesson", module: 0, articleSlug: "intro" },
      { op: "add_card", front: "  What is   a pin?  ", back: "One article revision.\r\n\r\n\r\nNever moves." },
      { op: "add_card", front: "Who sees drafts?", back: "Authors only." },
    ]);
    const studio = (await getStudioCourse(pool, erin, c.id))!;
    expect(studio.cards.map((k) => [k.front, k.back])).toEqual([
      ["What is a pin?", "One article revision.\n\nNever moves."],
      ["Who sees drafts?", "Authors only."],
    ]);
    expect(studio.publishedCards).toBeNull();
    expect(await getPublishedCards(pool, "flash")).toBeNull();
    ok(await publishCourse(pool, erin, { id: c.id, revisionId: rev, publication: await shown(erin, c.id) }));
    const published = (await getPublishedCards(pool, "flash"))!;
    expect(published.cards.map((k) => k.front)).toEqual(["What is a pin?", "Who sees drafts?"]);
    expect(published.course.cards).toBe(2);

    // Edit, reorder and remove: each a new draft revision; the card ids stay, guests keep the published two.
    const [first, second] = studio.cards;
    await edit(erin, c.id, [
      { op: "edit_card", cardId: first!.cardId, front: "What is a lesson pin?", back: "A revision." },
      { op: "move_card", cardId: second!.cardId, delta: -1 },
      { op: "add_card", front: "Third", back: "Card" },
    ]);
    const third = (await getStudioCourse(pool, erin, c.id))!.cards[2]!;
    await edit(erin, c.id, [{ op: "remove_card", cardId: third.cardId }]);
    const draftNow = (await getStudioCourse(pool, erin, c.id))!;
    expect(draftNow.cards.map((k) => [k.cardId, k.front])).toEqual([
      [second!.cardId, "Who sees drafts?"],
      [first!.cardId, "What is a lesson pin?"],
    ]);
    expect([draftNow.draftIsPublished, draftNow.publishedCards]).toEqual([false, 2]);
    expect((await getPublishedCards(pool, "flash"))!.cards[0]!.front).toBe("What is a pin?");
    ok(
      await publishCourse(pool, erin, {
        id: c.id,
        revisionId: draftNow.draftRevisionId,
        publication: await shown(erin, c.id),
      }),
    );
    expect((await getPublishedCards(pool, "flash"))!.cards.map((k) => k.front)).toEqual([
      "Who sees drafts?",
      "What is a lesson pin?",
    ]);

    // Empty or oversized sides, and unknown cards, are refused; stored cards are immutable.
    const head = draftNow.draftRevisionId;
    const refused = (e: CourseEdit) => editCourse(pool, erin, { id: c.id, expectedRevisionId: head, edit: e });
    expect(await refused({ op: "add_card", front: "   ", back: "x" })).toEqual({ ok: false, error: "invalid_card" });
    expect(await refused({ op: "add_card", front: "x", back: "y".repeat(1001) })).toEqual({
      ok: false,
      error: "invalid_card",
    });
    expect(await refused({ op: "remove_card", cardId: "nope" })).toEqual({ ok: false, error: "unknown_card" });
    await expect(pool.query("UPDATE course_cards SET front = 'x'")).rejects.toThrow(/immutable/);
  });

  it("sets, checks and removes a course's cover image, published with the revision", async () => {
    const c = ok(await createCourse(pool, erin, { slug: "covered", title: "Covered" }));
    const rev = await edit(erin, c.id, [
      { op: "add_module", title: "A" },
      { op: "add_lesson", module: 0, articleSlug: "intro" },
      { op: "cover", url: " https://images.example.org/a.png#x ", alt: "  A   chart " },
    ]);
    expect((await getStudioCourse(pool, erin, c.id))!.cover).toEqual({
      url: "https://images.example.org/a.png",
      svg: "",
      alt: "A chart",
    });
    ok(await publishCourse(pool, erin, { id: c.id, revisionId: rev, publication: await shown(erin, c.id) }));
    expect((await getPublishedCourse(pool, "covered"))!.cover.url).toBe("https://images.example.org/a.png");
    expect((await listPublishedCourses(pool)).items.find((s) => s.slug === "covered")!.cover.alt).toBe("A chart");
    for (const url of ["http://images.example.org/a.png", "https://127.0.0.1/a.png", "https://localhost/a.png"]) {
      expect(
        await editCourse(pool, erin, { id: c.id, expectedRevisionId: rev, edit: { op: "cover", url, alt: "" } }),
      ).toEqual({ ok: false, error: "invalid_cover" });
    }
    await edit(erin, c.id, [{ op: "cover", url: "", alt: "ignored" }]);
    expect((await getStudioCourse(pool, erin, c.id))!.cover).toEqual({ url: "", svg: "", alt: "" });
    // Guests keep the published cover until the next publish.
    expect((await getPublishedCourse(pool, "covered"))!.cover.url).toBe("https://images.example.org/a.png");
  });

  it("takes pasted SVG code as a cover, refuses unsafe SVG, and keeps only one cover source", async () => {
    const c = ok(await createCourse(pool, erin, { slug: "svg-covered", title: "SVG covered" }));
    let rev = await edit(erin, c.id, [
      { op: "add_module", title: "A" },
      { op: "add_lesson", module: 0, articleSlug: "intro" },
      { op: "cover", url: "https://images.example.org/a.png", alt: "" },
      {
        op: "cover",
        url: "https://ignored.example.org/b.png",
        svg: ' <svg viewBox="0 0 4 3"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="4" height="3"/><use href="#g"/></svg> ',
        alt: "Shapes",
      },
    ]);
    const cover = (await getStudioCourse(pool, erin, c.id))!.cover;
    expect(cover.url).toBe("");
    expect(cover.alt).toBe("Shapes");
    expect(cover.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(coverSrc(cover)).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
    ok(await publishCourse(pool, erin, { id: c.id, revisionId: rev, publication: await shown(erin, c.id) }));
    expect((await getPublishedCourse(pool, "svg-covered"))!.cover.svg).toBe(cover.svg);
    expect((await listPublishedCourses(pool)).items.find((s) => s.slug === "svg-covered")!.cover.svg).toBe(cover.svg);

    const refused: [string, string][] = [
      ["<svg><script>alert(1)</script></svg>", "unsafe_cover_svg"],
      ['<svg onload="alert(1)"><rect/></svg>', "unsafe_cover_svg"],
      ['<svg><image href="https://tracker.example.org/x.png"/></svg>', "external_cover_svg"],
      ['<svg><use xlink:href="other.svg#a"/></svg>', "external_cover_svg"],
      ['<svg><rect style="fill: url(https://x.example.org/p.svg)"/></svg>', "external_cover_svg"],
      ["<svg><style>@import 'https://x.example.org/a.css';</style></svg>", "external_cover_svg"],
      ['<svg><a href="javascript:alert(1)"><rect/></a></svg>', "unsafe_cover_svg"],
      ["<div>not svg</div>", "invalid_cover_svg"],
      ["<svg><rect></svg>", "invalid_cover_svg"],
      [`<svg>${"<rect/>".repeat(20_000)}</svg>`, "cover_svg_too_large"],
    ];
    for (const [svg, error] of refused) {
      expect(
        await editCourse(pool, erin, {
          id: c.id,
          expectedRevisionId: rev,
          edit: { op: "cover", url: "", svg, alt: "" },
        }),
      ).toEqual({ ok: false, error });
    }
    // Back to an address: the SVG goes.
    rev = await edit(erin, c.id, [{ op: "cover", url: "https://images.example.org/c.png", svg: "  ", alt: "" }]);
    expect((await getStudioCourse(pool, erin, c.id))!.cover).toEqual({
      url: "https://images.example.org/c.png",
      svg: "",
      alt: "",
    });
    // The database refuses a revision with both, whatever the code does.
    await expect(pool.query("UPDATE course_revisions SET cover_svg = '<svg/>' WHERE id = $1", [rev])).rejects.toThrow();
  });

  it("pages through course lists without repeating or skipping one", async () => {
    const all = (await listStudioCourses(pool, erin)).items.map((s) => s.id);
    const seen: string[] = [];
    let after: string | null = null;
    do {
      const page = await listStudioCourses(pool, erin, { after, limit: 2 });
      seen.push(...page.items.map((s) => s.id));
      after = page.next;
    } while (after);
    expect(seen).toEqual(all);
    const published = (await listPublishedCourses(pool)).items.map((s) => s.slug);
    expect(published.length).toBeGreaterThan(1);
    const first = await listPublishedCourses(pool, { limit: 1 });
    const rest = await listPublishedCourses(pool, { after: first.next });
    expect([...first.items, ...rest.items].map((s) => s.slug)).toEqual(published);
  });
});
