/**
 * Course assessments on a real PostgreSQL: who may manage the bank, AI generation (with a stand-in provider),
 * learners' attempts graded on the server, the 3-day retake lock, expiry, insights, and question images.
 * Runs when KNOWLEDGE_TEST_DATABASE_URL names a server where it may create a throwaway database.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../platform.app";
import { generateAssessmentQuestions } from "../lib/ai/assessment";
import type { AiProvider } from "../lib/ai/provider";
import { NO_IMAGE, type QuestionInput } from "../lib/assessment-core";
import {
  assessmentTeaser,
  changeBank,
  getAttempt,
  getLearnerAssessment,
  getStudioAssessment,
  listAvailableAssessments,
  listMyAssessments,
  listStudioAssessments,
  saveQuestion,
  startAttempt,
  submitAttempt,
  updateSettings,
} from "../lib/assessments";
import { createArticle, publishRevision } from "../lib/content";
import {
  createCourse,
  editCourse,
  getPublishedCourse,
  getStudioCourse,
  publishCourse,
  type CourseEdit,
} from "../lib/courses";
import { readableAsset } from "../lib/media/assets";
import { migrate } from "../lib/migrations";
import type { Actor } from "../lib/policy";

const ADMIN_URL = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const grants = (role: string) => manifest.roles.find((r) => r.key === role)!.grants;
const alice: Actor = { subject: "alice", permissions: grants("knowledge.author") };
const bob: Actor = { subject: "bob", permissions: grants("knowledge.author") };
const erin: Actor = { subject: "erin", permissions: grants("knowledge.editor") };
const DAY = 24 * 3600_000;

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

const single = (prompt: string, lessonId: string | null, right = 1): QuestionInput => ({
  kind: "single",
  prompt,
  options: [1, 2, 3].map((i) => ({ id: `o${i}`, text: `${prompt} answer ${i}`, correct: i === right })),
  explanation: `Because ${right}.`,
  lessonId,
  difficulty: "medium",
  image: NO_IMAGE,
});

describe.skipIf(!ADMIN_URL)("course assessments on PostgreSQL", () => {
  const dbName = `knowledge_assess_${randomBytes(6).toString("hex")}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let courseId: string;
  let lessons: { lessonId: string; title: string }[];

  const version = async (actor: Actor = alice) => (await getStudioAssessment(pool, actor, courseId))!.settings.version;

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
    for (const [slug, title, body] of [
      ["closures", "Closures", "# Closures\n\nA closure keeps the variables of the scope it was created in."],
      ["promises", "Promises", "# Promises\n\nA promise is pending, then fulfilled or rejected."],
    ]) {
      const a = ok(
        await createArticle(pool, alice, { slug: slug!, draft: { title: title!, summary: "", body: body! } }),
      );
      ok(await publishRevision(pool, alice, { id: a.id, revisionId: a.revisionId }));
    }
    const created = ok(await createCourse(pool, alice, { slug: "js", title: "JavaScript" }));
    courseId = created.id;
    let rev = created.revisionId;
    for (const e of [
      { op: "add_module", title: "Functions" },
      { op: "add_lesson", module: 0, articleSlug: "closures" },
      { op: "add_module", title: "Async" },
      { op: "add_lesson", module: 1, articleSlug: "promises" },
    ] as CourseEdit[])
      rev = ok(await editCourse(pool, alice, { id: courseId, expectedRevisionId: rev, edit: e })).revisionId;
    const pub = (await getStudioCourse(pool, alice, courseId))!.publication;
    ok(await publishCourse(pool, alice, { id: courseId, revisionId: rev, publication: pub }));
    lessons = (await getPublishedCourse(pool, "js"))!.modules.flatMap((m) => m.lessons);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it("only the course's owner or someone who manages every course manages its assessment", async () => {
    expect(await getStudioAssessment(pool, bob, courseId)).toBeNull();
    expect(
      await saveQuestion(pool, bob, {
        courseId,
        version: 0,
        questionId: null,
        question: single("Q", null),
        status: "active",
      }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(await getStudioAssessment(pool, erin, courseId)).not.toBeNull();
    expect(await getStudioAssessment(pool, alice, courseId)).toMatchObject({
      settings: { status: "draft", version: 0 },
    });
  });

  it("generates questions with AI as drafts, tied to the lessons, from the lesson text", async () => {
    let sent = "";
    const provider: AiProvider = {
      provider: "fake",
      model: "fake-model",
      countInput: async () => 1000,
      generate: async (req) => {
        sent = req.user;
        expect(req.long?.timeoutMs).toBeGreaterThan(0);
        return {
          model: "fake-model",
          usage: { inputTokens: 900, outputTokens: 800 },
          answer: {
            questions: [
              {
                lessonId: lessons[0]!.lessonId,
                kind: "single",
                difficulty: "easy",
                prompt: "What does a closure keep?",
                options: [
                  { text: "The variables of its scope", correct: true },
                  { text: "Nothing", correct: false },
                  { text: "Only globals", correct: false },
                ],
                explanation: "It keeps its scope's variables.",
                svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
                svgAlt: "A square",
              },
              {
                lessonId: lessons[1]!.lessonId,
                kind: "multiple",
                difficulty: "hard",
                prompt: "Which are states of a promise? Choose all that apply.",
                options: [
                  { text: "pending", correct: true },
                  { text: "fulfilled", correct: true },
                  { text: "sleeping", correct: false },
                  { text: "rejected", correct: true },
                ],
                explanation: "Pending, then fulfilled or rejected.",
                svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
                svgAlt: "",
              },
              // Unusable: two correct answers on a single-answer question.
              {
                lessonId: lessons[1]!.lessonId,
                kind: "single",
                difficulty: "medium",
                prompt: "Broken",
                options: [
                  { text: "a", correct: true },
                  { text: "b", correct: true },
                ],
                explanation: "",
                svg: "",
                svgAlt: "",
              },
            ],
          },
        };
      },
    };
    const caps = { monthlyTokenCap: 1_000_000, authorMonthlyTokenCap: 500_000 };
    const options = {
      count: 3,
      kinds: "mixed" as const,
      difficulty: "mixed" as const,
      lessonIds: [],
      diagrams: true,
      instruction: "",
    };
    expect(await generateAssessmentQuestions(pool, { provider, caps }, bob, { courseId, options })).toEqual({
      ok: false,
      error: "assessment_not_found",
    });
    const r = ok(await generateAssessmentQuestions(pool, { provider, caps }, alice, { courseId, options }));
    expect(r).toMatchObject({ added: 2, trimmed: false });
    expect(sent).toContain("A closure keeps the variables");
    expect(sent).toContain("A promise is pending");
    const bank = (await getStudioAssessment(pool, alice, courseId))!.questions;
    expect(bank.map((q) => [q.status, q.source, q.lessonId])).toEqual([
      ["draft", "ai", lessons[0]!.lessonId],
      ["draft", "ai", lessons[1]!.lessonId],
    ]);
    expect(bank[0]!.image.svg).toContain("<rect");
    // The unsafe diagram is dropped, the question kept.
    expect(bank[1]!.image.svg).toBe("");
    const { rows } = await pool.query("SELECT operation, item_id, status FROM ai_jobs");
    expect(rows).toEqual([{ operation: "assessment", item_id: courseId, status: "succeeded" }]);
  });

  it("can't open with fewer than 3 approved questions; a stale form is refused", async () => {
    const v = await version();
    expect(
      await updateSettings(pool, alice, {
        courseId,
        version: v,
        status: "open",
        questionsPerAttempt: 3,
        passPercent: 60,
      }),
    ).toEqual({ ok: false, error: "too_few_questions" });
    ok(await changeBank(pool, alice, { courseId, version: v, change: { op: "approve_drafts" } }));
    expect(
      await saveQuestion(pool, alice, {
        courseId,
        version: v,
        questionId: null,
        question: single("Stale", null),
        status: "active",
      }),
    ).toEqual({ ok: false, error: "conflict" });
    ok(
      await saveQuestion(pool, alice, {
        courseId,
        version: await version(),
        questionId: null,
        question: single("Where is the event loop?", null, 2),
        status: "active",
      }),
    );
    expect(
      await saveQuestion(pool, alice, {
        courseId,
        version: await version(),
        questionId: null,
        question: single("Unknown lesson", "not-a-lesson"),
        status: "active",
      }),
    ).toEqual({ ok: false, error: "unknown_lesson" });
    expect(await assessmentTeaser(pool, "js")).toBeNull();
    ok(
      await updateSettings(pool, alice, {
        courseId,
        version: await version(),
        status: "open",
        questionsPerAttempt: 3,
        passPercent: 60,
      }),
    );
    expect(await assessmentTeaser(pool, "js")).toEqual({ questions: 3 });
  });

  it("a learner takes it: no answers sent, graded on the server, locked for 3 days", async () => {
    const t0 = new Date();
    const start = ok(await startAttempt(pool, "lena", "js", t0));
    // A second start resumes the same attempt.
    expect(await startAttempt(pool, "lena", "js", t0)).toEqual({ ok: true, id: start.id, resumed: true });
    const view = (await getAttempt(pool, "lena", start.id, t0))!;
    expect(view.result).toBeNull();
    expect(JSON.stringify(view.toAnswer)).not.toMatch(/correct|explanation/);
    expect(await getAttempt(pool, "mallory", start.id, t0)).toBeNull();

    // Answer everything right except the promise question (one right, one wrong pick: 1/3 - 1/3 = 0).
    const { rows } = await pool.query<{
      questions: { id: string; kind: string; options: { id: string; correct: boolean }[] }[];
    }>("SELECT questions FROM assessment_attempts WHERE id = $1", [start.id]);
    const answers: Record<string, string[]> = {};
    for (const q of rows[0]!.questions) {
      const right = q.options.filter((o) => o.correct).map((o) => o.id);
      const wrong = q.options.filter((o) => !o.correct).map((o) => o.id);
      answers[q.id] = q.kind === "multiple" ? [right[0]!, wrong[0]!] : right;
    }
    expect(ok(await submitAttempt(pool, "lena", start.id, answers, t0)).score).toBe(67);
    expect(await submitAttempt(pool, "lena", start.id, answers, t0)).toEqual({ ok: false, error: "attempt_closed" });

    const result = (await getAttempt(pool, "lena", start.id, t0))!.result!;
    expect(result).toMatchObject({ passed: true, grade: { correct: 2, total: 3 } });

    const locked = await startAttempt(pool, "lena", "js", new Date(t0.getTime() + 2 * DAY));
    expect(locked).toMatchObject({ ok: false, error: "locked" });
    const learner = (await getLearnerAssessment(pool, "lena", "js", new Date(t0.getTime() + DAY)))!;
    expect(learner.lockedUntil).not.toBeNull();
    expect(learner.insights.focus.map((f) => f.lessonId)).toEqual([lessons[1]!.lessonId]);
    expect(learner.insights.modules.find((m) => m.title === "Async")!.mastery).toBe(0);
    expect(ok(await startAttempt(pool, "lena", "js", new Date(t0.getTime() + 3 * DAY + 1000))).resumed).toBe(false);
  });

  it("an attempt left open past its time is graded as it stands (nothing answered)", async () => {
    const t0 = new Date();
    const a = ok(await startAttempt(pool, "pete", "js", t0));
    const later = new Date(t0.getTime() + 2 * 3600_000);
    expect(await submitAttempt(pool, "pete", a.id, {}, later)).toEqual({ ok: true, score: 0 });
    const b = (await getAttempt(pool, "pete", a.id, later))!.result!;
    expect(b.expired).toBe(true);
    expect((await listMyAssessments(pool, "pete")).map((m) => [m.slug, m.latest])).toEqual([["js", 0]]);
  });

  it("question stats show the studio how learners do", async () => {
    const s = (await getStudioAssessment(pool, alice, courseId))!;
    expect(s.attempts).toBe(2);
    expect(s.learners).toBe(2);
    const promise = s.questions.find((q) => q.kind === "multiple")!;
    expect(promise.stats).toMatchObject({ asked: 2, correctPercent: 0, commonWrongOption: "sleeping" });
  });

  it("the Assessments dashboard lists every course the person manages, with or without an assessment", async () => {
    const other = ok(await createCourse(pool, bob, { slug: "bobs-course", title: "Bob's course" }));
    const mine = await listStudioAssessments(pool, alice);
    expect(mine.map((r) => r.slug)).toEqual(["js"]);
    expect(mine[0]).toMatchObject({
      courseStatus: "published",
      status: "open",
      active: 3,
      drafts: 0,
      attempts: 2,
      learners: 2,
      average: 34,
      passRate: 50,
    });
    expect(mine[0]!.lastAttemptAt).toBeInstanceOf(Date);
    // Bob's new course has no assessment yet; it is listed (so one can be started), after the open one for an editor.
    expect(await listStudioAssessments(pool, bob)).toMatchObject([
      { courseId: other.id, status: null, active: 0, attempts: 0, average: null, passRate: null },
    ]);
    expect((await listStudioAssessments(pool, erin)).map((r) => r.slug)).toEqual(["js", "bobs-course"]);
    // Without a course permission there is nothing to manage.
    expect(await listStudioAssessments(pool, { subject: "alice", permissions: [] })).toEqual([]);
  });

  it("learners see the assessments they can take now", async () => {
    expect(await listAvailableAssessments(pool)).toEqual([{ slug: "js", title: "JavaScript", questions: 3 }]);
  });

  it("deleting questions never changes a past result, and too few approved closes it", async () => {
    const bank = (await getStudioAssessment(pool, alice, courseId))!.questions;
    ok(
      await changeBank(pool, alice, {
        courseId,
        version: await version(),
        change: { op: "delete", questionId: bank[0]!.id },
      }),
    );
    const lena = (await listMyAssessments(pool, "lena"))[0]!;
    expect(lena.latest).toBe(67);
    expect((await getStudioAssessment(pool, alice, courseId))!.settings.status).toBe("draft");
    expect(await startAttempt(pool, "zoe", "js")).toEqual({ ok: false, error: "not_open" });
  });

  it("an uploaded image on a question is public only while the assessment is open on a published course", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    await pool.query(
      `INSERT INTO media_assets (id, owner_subject, kind, content_type, byte_size, filename, status, checked_at)
       VALUES ($1, 'alice', 'image', 'image/png', 10, 'diagram.png', 'ready', now())`,
      [id],
    );
    expect(
      await saveQuestion(pool, bob, {
        courseId,
        version: await version(),
        questionId: null,
        question: { ...single("Img", null), image: { ...NO_IMAGE, assetId: id, alt: "x" } },
        status: "active",
      }),
    ).toEqual({ ok: false, error: "not_found" });
    ok(
      await saveQuestion(pool, alice, {
        courseId,
        version: await version(),
        questionId: null,
        question: { ...single("Read the diagram", null), image: { ...NO_IMAGE, assetId: id, alt: "A diagram" } },
        status: "active",
      }),
    );
    expect(await readableAsset(pool, null, id)).toBeNull();
    ok(
      await updateSettings(pool, alice, {
        courseId,
        version: await version(),
        status: "open",
        questionsPerAttempt: 3,
        passPercent: 60,
      }),
    );
    expect((await readableAsset(pool, null, id))?.isPublic).toBe(true);
    // In use: it can't be cleaned up or deleted while a question shows it.
    const { rows } = await pool.query(
      "SELECT 1 FROM media_assets a WHERE a.id = $1 AND EXISTS (SELECT 1 FROM assessment_questions q WHERE q.image_asset_id = a.id)",
      [id],
    );
    expect(rows).toHaveLength(1);
  });
});
