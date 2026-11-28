/**
 * Course assessments on the database: each course's question bank (managed by whoever may manage the course: its
 * owner, or someone who manages every course), and learners' attempts.
 *
 * The bank is edited in place, not in revisions: every change bumps the assessment's version, and every studio form
 * names the version it showed, so a stale tab can't overwrite a newer change. An attempt copies the questions it
 * asks (with their answers) when it starts; the browser only ever gets them without the answers, the answers it
 * sends are graded here, and a past result never changes when a question is edited or deleted later.
 *
 * Learners: signed in, nothing more. They take an open assessment of a published course, one attempt at a time; once
 * an attempt is submitted (or its time runs out) the next one can start RETAKE_DAYS later.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  ASSESSMENT_LIMITS,
  attemptMinutes,
  buildInsights,
  checkQuestion,
  cleanAnswers,
  gradeAttempt,
  nextAttemptAt,
  NO_IMAGE,
  pickQuestions,
  SUBMIT_GRACE_MS,
  withoutAnswers,
  type Answers,
  type AskedQuestion,
  type AssessmentInsights,
  type AttemptGrade,
  type Difficulty,
  type GradedAttempt,
  type Question,
  type QuestionHistory,
  type QuestionInput,
  type QuestionKind,
  type QuestionOption,
  type QuestionSource,
  type QuestionStatus,
  type QuestionError,
  type QuestionToAnswer,
} from "./assessment-core";
import { getPublishedCourse, type PublishedCourse } from "./courses";
import { checkCoverSvg, checkImageUrl, isAssetId } from "./media/validate";
import { canCreateCourse, canManageCourse, seesAll, seesAllCourses, type Actor } from "./policy";

type Pool = Pick<pg.Pool, "connect" | "query">;
type Client = Pick<pg.PoolClient, "query">;

export type AssessmentStatus = "draft" | "open";

export type AssessmentError =
  | "not_found"
  | "forbidden"
  | "conflict"
  | "invalid_settings"
  | "unknown_question"
  | "unknown_lesson"
  | "bank_full"
  | "image_invalid"
  | "image_unavailable"
  | "too_few_questions"
  | "not_open"
  | "locked"
  | "attempt_closed"
  | QuestionError
  | "svg_invalid"
  | "svg_unsafe"
  | "svg_external"
  | "svg_too_large";

export type AssessmentResult<T> = ({ ok: true } & T) | { ok: false; error: AssessmentError; until?: Date };

interface QuestionRow {
  id: string;
  course_id: string;
  position: number;
  kind: QuestionKind;
  prompt: string;
  options: QuestionOption[];
  explanation: string;
  lesson_id: string | null;
  difficulty: Difficulty;
  status: QuestionStatus;
  source: QuestionSource;
  image_url: string;
  image_svg: string;
  image_asset_id: string | null;
  image_alt: string;
}

const toQuestion = (r: QuestionRow): Question => ({
  id: r.id,
  position: r.position,
  kind: r.kind,
  prompt: r.prompt,
  options: r.options,
  explanation: r.explanation,
  lessonId: r.lesson_id,
  difficulty: r.difficulty,
  status: r.status,
  source: r.source,
  image: { url: r.image_url, svg: r.image_svg, assetId: r.image_asset_id, alt: r.image_alt },
});

interface SettingsRow {
  course_id: string;
  status: AssessmentStatus;
  questions_per_attempt: number;
  pass_percent: number;
  version: number;
}

export interface AssessmentSettings {
  status: AssessmentStatus;
  questionsPerAttempt: number;
  passPercent: number;
  version: number;
}

const DEFAULT_SETTINGS: AssessmentSettings = { status: "draft", questionsPerAttempt: 10, passPercent: 70, version: 0 };

const toSettings = (r: SettingsRow | undefined): AssessmentSettings =>
  r
    ? {
        status: r.status,
        questionsPerAttempt: r.questions_per_attempt,
        passPercent: r.pass_percent,
        version: r.version,
      }
    : DEFAULT_SETTINGS;

async function inTransaction<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const audit = (c: Client, actor: string, action: string, courseId: string, questionId: string | null, detail = "") =>
  c.query(
    "INSERT INTO assessment_audit_events (actor, action, course_id, question_id, detail) VALUES ($1, $2, $3, $4, $5)",
    [actor, action, courseId, questionId, detail.slice(0, 200)],
  );

/**
 * For a studio change: the course (the actor must manage it) and its assessment row, locked, created on first use.
 * `version` (when given) must be the one the page showed.
 */
export async function lockForChange(
  c: Client,
  actor: Actor,
  courseId: string,
  version: number | null,
): Promise<
  { ok: true; settings: AssessmentSettings; draftRevisionId: string } | { ok: false; error: AssessmentError }
> {
  const course = (
    await c.query<{ owner_subject: string; draft_revision_id: string }>(
      "SELECT owner_subject, draft_revision_id FROM courses WHERE id = $1 FOR SHARE",
      [courseId],
    )
  ).rows[0];
  if (!course || !canManageCourse(actor, { ownerSubject: course.owner_subject }))
    return { ok: false, error: "not_found" };
  await c.query("INSERT INTO assessments (course_id) VALUES ($1) ON CONFLICT DO NOTHING", [courseId]);
  const row = (await c.query<SettingsRow>("SELECT * FROM assessments WHERE course_id = $1 FOR UPDATE", [courseId]))
    .rows[0]!;
  if (version !== null && row.version !== version) return { ok: false, error: "conflict" };
  return { ok: true, settings: toSettings(row), draftRevisionId: course.draft_revision_id };
}

const bump = (c: Client, courseId: string) =>
  c.query("UPDATE assessments SET version = version + 1, updated_at = now() WHERE course_id = $1", [courseId]);

/** The lessons a question may test: those of the course's draft or published revision. */
async function courseLessonIds(c: Client, courseId: string): Promise<Set<string>> {
  const { rows } = await c.query<{ lesson_id: string }>(
    `SELECT DISTINCT l.lesson_id FROM courses co JOIN course_lessons l
       ON l.revision_id IN (co.draft_revision_id, co.published_revision_id)
     WHERE co.id = $1`,
    [courseId],
  );
  return new Set(rows.map((r) => r.lesson_id));
}

/**
 * The picture's source, checked: an https address on a named host, self-contained SVG code (like a course cover), or
 * a ready image this person may use (their own, one this question already shows, or any for someone who sees every
 * article).
 */
async function checkImage(
  c: Client,
  actor: Actor,
  image: QuestionInput["image"],
  questionId: string | null,
): Promise<{ ok: true; image: QuestionInput["image"] } | { ok: false; error: AssessmentError }> {
  const alt = image.alt;
  if (image.assetId) {
    if (!isAssetId(image.assetId)) return { ok: false, error: "image_unavailable" };
    const { rowCount } = await c.query(
      `SELECT 1 FROM media_assets a WHERE a.id = $1 AND a.status = 'ready' AND a.kind = 'image'
         AND ($2::boolean OR a.owner_subject = $3
              OR EXISTS (SELECT 1 FROM assessment_questions q WHERE q.id = $4 AND q.image_asset_id = a.id))
       FOR SHARE OF a`,
      [image.assetId, seesAll(actor), actor.subject, questionId],
    );
    return rowCount
      ? { ok: true, image: { ...NO_IMAGE, assetId: image.assetId, alt } }
      : { ok: false, error: "image_unavailable" };
  }
  if (image.svg.trim()) {
    const svg = checkCoverSvg(image.svg);
    if (!svg.ok) return { ok: false, error: svg.error };
    return { ok: true, image: { ...NO_IMAGE, svg: svg.svg, alt } };
  }
  if (image.url.trim()) {
    const url = checkImageUrl(image.url);
    return url ? { ok: true, image: { ...NO_IMAGE, url, alt } } : { ok: false, error: "image_invalid" };
  }
  return { ok: true, image: { ...NO_IMAGE } };
}

/** Insert checked questions at the end of the bank. Used by the studio and by AI generation. */
export async function insertQuestions(
  c: Client,
  actor: Actor,
  courseId: string,
  questions: { input: QuestionInput; status: QuestionStatus; source: QuestionSource }[],
): Promise<string[]> {
  const { rows } = await c.query<{ n: number; next: number }>(
    "SELECT count(*)::int AS n, coalesce(max(position) + 1, 0)::int AS next FROM assessment_questions WHERE course_id = $1",
    [courseId],
  );
  if (rows[0]!.n + questions.length > ASSESSMENT_LIMITS.bank) throw new BankFullError();
  const ids: string[] = [];
  for (const [i, q] of questions.entries()) {
    const id = randomUUID();
    ids.push(id);
    await c.query(
      `INSERT INTO assessment_questions (id, course_id, position, kind, prompt, options, explanation, lesson_id, difficulty,
         status, source, image_url, image_svg, image_asset_id, image_alt, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        id,
        courseId,
        rows[0]!.next + i,
        q.input.kind,
        q.input.prompt,
        JSON.stringify(q.input.options),
        q.input.explanation,
        q.input.lessonId,
        q.input.difficulty,
        q.status,
        q.source,
        q.input.image.url,
        q.input.image.svg,
        q.input.image.assetId,
        q.input.image.alt,
        actor.subject,
      ],
    );
  }
  return ids;
}

export class BankFullError extends Error {
  constructor() {
    super("assessment bank full");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Studio: settings and questions

export async function updateSettings(
  pool: Pool,
  actor: Actor,
  input: {
    courseId: string;
    version: number;
    status: AssessmentStatus;
    questionsPerAttempt: number;
    passPercent: number;
  },
): Promise<AssessmentResult<object>> {
  const { minPerAttempt, maxPerAttempt } = ASSESSMENT_LIMITS;
  if (
    !["draft", "open"].includes(input.status) ||
    !Number.isInteger(input.questionsPerAttempt) ||
    input.questionsPerAttempt < minPerAttempt ||
    input.questionsPerAttempt > maxPerAttempt ||
    !Number.isInteger(input.passPercent) ||
    input.passPercent < 1 ||
    input.passPercent > 100
  )
    return { ok: false, error: "invalid_settings" };
  return inTransaction(pool, async (c) => {
    const lock = await lockForChange(c, actor, input.courseId, input.version);
    if (!lock.ok) return lock;
    if (input.status === "open") {
      const { rows } = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM assessment_questions WHERE course_id = $1 AND status = 'active'",
        [input.courseId],
      );
      if (rows[0]!.n < minPerAttempt) return { ok: false, error: "too_few_questions" } as const;
    }
    await c.query(
      `UPDATE assessments SET status = $2, questions_per_attempt = $3, pass_percent = $4, version = version + 1, updated_at = now()
       WHERE course_id = $1`,
      [input.courseId, input.status, input.questionsPerAttempt, input.passPercent],
    );
    await audit(c, `user:${actor.subject}`, "assessment.settings", input.courseId, null, input.status);
    return { ok: true } as const;
  });
}

/** Create (no questionId) or replace one question. */
export async function saveQuestion(
  pool: Pool,
  actor: Actor,
  input: {
    courseId: string;
    version: number;
    questionId: string | null;
    question: QuestionInput;
    status: QuestionStatus;
  },
): Promise<AssessmentResult<{ id: string }>> {
  const checked = checkQuestion(input.question);
  if (!checked.ok) return checked;
  return inTransaction(pool, async (c) => {
    const lock = await lockForChange(c, actor, input.courseId, input.version);
    if (!lock.ok) return lock;
    const q = checked.question;
    if (q.lessonId && !(await courseLessonIds(c, input.courseId)).has(q.lessonId))
      return { ok: false, error: "unknown_lesson" } as const;
    const image = await checkImage(c, actor, q.image, input.questionId);
    if (!image.ok) return image;
    const question = { ...q, image: image.image };
    const status: QuestionStatus = input.status === "active" ? "active" : "draft";
    if (!input.questionId) {
      try {
        const [id] = await insertQuestions(c, actor, input.courseId, [{ input: question, status, source: "author" }]);
        await bump(c, input.courseId);
        await audit(c, `user:${actor.subject}`, "assessment.question.created", input.courseId, id!);
        return { ok: true, id: id! } as const;
      } catch (err) {
        if (err instanceof BankFullError) return { ok: false, error: "bank_full" } as const;
        throw err;
      }
    }
    const { rowCount } = await c.query(
      `UPDATE assessment_questions SET kind = $3, prompt = $4, options = $5, explanation = $6, lesson_id = $7, difficulty = $8,
         status = $9, image_url = $10, image_svg = $11, image_asset_id = $12, image_alt = $13, updated_at = now()
       WHERE id = $1 AND course_id = $2`,
      [
        input.questionId,
        input.courseId,
        question.kind,
        question.prompt,
        JSON.stringify(question.options),
        question.explanation,
        question.lessonId,
        question.difficulty,
        status,
        question.image.url,
        question.image.svg,
        question.image.assetId,
        question.image.alt,
      ],
    );
    if (!rowCount) return { ok: false, error: "unknown_question" } as const;
    await bump(c, input.courseId);
    await audit(c, `user:${actor.subject}`, "assessment.question.saved", input.courseId, input.questionId);
    return { ok: true, id: input.questionId } as const;
  });
}

export type BankChange =
  | { op: "delete"; questionId: string }
  | { op: "status"; questionId: string; status: QuestionStatus }
  | { op: "move"; questionId: string; delta: -1 | 1 }
  | { op: "approve_drafts" }
  | { op: "delete_drafts" };

/** The smaller changes: delete, approve or unpublish one, move, and the bulk ones for a fresh AI batch. */
export async function changeBank(
  pool: Pool,
  actor: Actor,
  input: { courseId: string; version: number; change: BankChange },
): Promise<AssessmentResult<{ count: number }>> {
  return inTransaction(pool, async (c) => {
    const lock = await lockForChange(c, actor, input.courseId, input.version);
    if (!lock.ok) return lock;
    const ch = input.change;
    const who = `user:${actor.subject}`;
    let count = 0;
    switch (ch.op) {
      case "delete":
      case "status": {
        const r =
          ch.op === "delete"
            ? await c.query("DELETE FROM assessment_questions WHERE id = $1 AND course_id = $2", [
                ch.questionId,
                input.courseId,
              ])
            : await c.query(
                "UPDATE assessment_questions SET status = $3, updated_at = now() WHERE id = $1 AND course_id = $2",
                [ch.questionId, input.courseId, ch.status === "active" ? "active" : "draft"],
              );
        if (!r.rowCount) return { ok: false, error: "unknown_question" } as const;
        count = r.rowCount;
        await audit(
          c,
          who,
          `assessment.question.${ch.op === "delete" ? "deleted" : ch.status}`,
          input.courseId,
          ch.questionId,
        );
        break;
      }
      case "move": {
        const { rows } = await c.query<{ id: string; position: number }>(
          "SELECT id, position FROM assessment_questions WHERE course_id = $1 ORDER BY position, id",
          [input.courseId],
        );
        const at = rows.findIndex((r) => r.id === ch.questionId);
        if (at < 0) return { ok: false, error: "unknown_question" } as const;
        const to = at + ch.delta;
        if (to >= 0 && to < rows.length) {
          const ids = rows.map((r) => r.id);
          [ids[at], ids[to]] = [ids[to]!, ids[at]!];
          await c.query(
            `UPDATE assessment_questions q SET position = o.ord - 1 FROM unnest($2::text[]) WITH ORDINALITY AS o (id, ord)
             WHERE q.id = o.id AND q.course_id = $1`,
            [input.courseId, ids],
          );
          count = 1;
        }
        break;
      }
      case "approve_drafts":
      case "delete_drafts": {
        const r =
          ch.op === "approve_drafts"
            ? await c.query(
                "UPDATE assessment_questions SET status = 'active', updated_at = now() WHERE course_id = $1 AND status = 'draft'",
                [input.courseId],
              )
            : await c.query("DELETE FROM assessment_questions WHERE course_id = $1 AND status = 'draft'", [
                input.courseId,
              ]);
        count = r.rowCount ?? 0;
        await audit(c, who, `assessment.${ch.op}`, input.courseId, null, String(count));
        break;
      }
    }
    // An open assessment needs enough active questions; a change that leaves too few closes it to learners.
    const { rows } = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM assessment_questions WHERE course_id = $1 AND status = 'active'",
      [input.courseId],
    );
    if (rows[0]!.n < ASSESSMENT_LIMITS.minPerAttempt)
      await c.query("UPDATE assessments SET status = 'draft' WHERE course_id = $1", [input.courseId]);
    await bump(c, input.courseId);
    return { ok: true, count } as const;
  });
}

export interface QuestionStats {
  asked: number;
  /** % of attempts that answered it exactly right; null when never asked. */
  correctPercent: number | null;
  /** The option chosen most often by those who got it wrong (a misleading distractor). */
  commonWrongOption: string | null;
}

export interface StudioAssessment {
  courseId: string;
  settings: AssessmentSettings;
  questions: (Question & { stats: QuestionStats })[];
  learners: number;
  attempts: number;
  averageScore: number | null;
  passRate: number | null;
}

/** The studio's view of a course's assessment; null when the actor may not manage the course. */
export async function getStudioAssessment(
  pool: Pick<Pool, "query">,
  actor: Actor,
  courseId: string,
): Promise<StudioAssessment | null> {
  const course = (
    await pool.query<{ owner_subject: string }>("SELECT owner_subject FROM courses WHERE id = $1", [courseId])
  ).rows[0];
  if (!course || !canManageCourse(actor, { ownerSubject: course.owner_subject })) return null;
  const [settings, questions, attempts] = await Promise.all([
    pool.query<SettingsRow>("SELECT * FROM assessments WHERE course_id = $1", [courseId]),
    pool.query<QuestionRow>("SELECT * FROM assessment_questions WHERE course_id = $1 ORDER BY position, id", [
      courseId,
    ]),
    pool.query<{
      subject: string;
      score: number;
      pass_percent: number;
      questions: AskedQuestion[];
      answers: Answers | null;
    }>(
      `SELECT subject, score, pass_percent, questions, answers FROM assessment_attempts
       WHERE course_id = $1 AND submitted_at IS NOT NULL ORDER BY submitted_at DESC LIMIT 2000`,
      [courseId],
    ),
  ]);
  const stats = new Map<string, { asked: number; right: number; wrong: Map<string, number> }>();
  for (const a of attempts.rows) {
    const grade = gradeAttempt(a.questions, a.answers ?? {});
    for (const q of a.questions) {
      const s = stats.get(q.id) ?? { asked: 0, right: 0, wrong: new Map() };
      s.asked += 1;
      if (grade.perQuestion[q.id]?.correct) s.right += 1;
      else
        for (const id of a.answers?.[q.id] ?? [])
          if (!q.options.find((o) => o.id === id)?.correct) s.wrong.set(id, (s.wrong.get(id) ?? 0) + 1);
      stats.set(q.id, s);
    }
  }
  const scores = attempts.rows.map((a) => a.score);
  return {
    courseId,
    settings: toSettings(settings.rows[0]),
    questions: questions.rows.map((r) => {
      const q = toQuestion(r);
      const s = stats.get(q.id);
      const top = s ? [...s.wrong].sort((a, b) => b[1] - a[1])[0] : undefined;
      return {
        ...q,
        stats: {
          asked: s?.asked ?? 0,
          correctPercent: s?.asked ? Math.round((s.right / s.asked) * 100) : null,
          commonWrongOption: top ? (q.options.find((o) => o.id === top[0])?.text ?? null) : null,
        },
      };
    }),
    learners: new Set(attempts.rows.map((a) => a.subject)).size,
    attempts: attempts.rows.length,
    averageScore: scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : null,
    passRate: scores.length
      ? Math.round((attempts.rows.filter((a) => a.score >= a.pass_percent).length / scores.length) * 100)
      : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Learners

interface AttemptRow {
  id: string;
  course_id: string;
  subject: string;
  started_at: Date;
  deadline: Date;
  submitted_at: Date | null;
  questions: AskedQuestion[];
  answers: Answers | null;
  points: string | null;
  correct: number | null;
  total: number;
  score: number | null;
  pass_percent: number;
  expired: boolean;
}

/** The open, published assessment of a published course, with the questions a learner may be asked. */
async function openAssessment(pool: Pick<Pool, "query">, slug: string) {
  const course = await getPublishedCourse(pool, slug);
  if (!course) return null;
  const settings = (await pool.query<SettingsRow>("SELECT * FROM assessments WHERE course_id = $1", [course.id]))
    .rows[0];
  if (!settings || settings.status !== "open") return { course, settings: null, bank: [] as Question[] };
  // Only questions about lessons guests can open now (or about the course in general).
  const visible = course.modules.flatMap((m) => m.lessons.map((l) => l.lessonId));
  const { rows } = await pool.query<QuestionRow>(
    `SELECT * FROM assessment_questions WHERE course_id = $1 AND status = 'active'
       AND (lesson_id IS NULL OR lesson_id = ANY($2::text[]))
     ORDER BY position`,
    [course.id, visible],
  );
  const bank = rows.map(toQuestion);
  return { course, settings: bank.length >= ASSESSMENT_LIMITS.minPerAttempt ? toSettings(settings) : null, bank };
}

/** For the course page: questions per attempt when a learner can take the assessment now; null otherwise. */
export async function assessmentTeaser(pool: Pick<Pool, "query">, slug: string): Promise<{ questions: number } | null> {
  const found = await openAssessment(pool, slug);
  if (!found?.settings) return null;
  return { questions: Math.min(found.settings.questionsPerAttempt, found.bank.length) };
}

/** An attempt whose time ran out unsubmitted is graded with no answers: peeking and walking away doesn't pay. */
async function expireStale(c: Pick<Pool, "query">, subject: string, courseId: string | null, now: Date) {
  const { rows } = await c.query<AttemptRow>(
    `SELECT * FROM assessment_attempts WHERE subject = $1 AND ($2::text IS NULL OR course_id = $2)
       AND submitted_at IS NULL AND deadline < $3`,
    [subject, courseId, new Date(now.getTime() - SUBMIT_GRACE_MS)],
  );
  for (const r of rows) await finish(c, r, {}, r.deadline, true);
}

async function finish(c: Pick<Pool, "query">, row: AttemptRow, answers: Answers, at: Date, expired: boolean) {
  const g = gradeAttempt(row.questions, answers);
  await c.query(
    `UPDATE assessment_attempts SET submitted_at = $2, answers = $3, points = $4, correct = $5, score = $6, expired = $7
     WHERE id = $1 AND submitted_at IS NULL`,
    [row.id, at, JSON.stringify(answers), g.points, g.correct, g.score, expired],
  );
  return g;
}

const toGraded = (r: AttemptRow): GradedAttempt => ({
  id: r.id,
  submittedAt: r.submitted_at!,
  score: r.score ?? 0,
  questions: r.questions,
  answers: r.answers ?? {},
});

export interface AttemptSummary {
  id: string;
  startedAt: Date;
  submittedAt: Date | null;
  score: number | null;
  correct: number | null;
  total: number;
  passed: boolean | null;
  expired: boolean;
}

const toSummary = (r: AttemptRow): AttemptSummary => ({
  id: r.id,
  startedAt: r.started_at,
  submittedAt: r.submitted_at,
  score: r.score,
  correct: r.correct,
  total: r.total,
  passed: r.score === null ? null : r.score >= r.pass_percent,
  expired: r.expired,
});

export interface LearnerAssessment {
  course: PublishedCourse;
  /** Null when there is nothing to take right now (not open, or too few questions). */
  open: { questionsPerAttempt: number; passPercent: number; minutes: number } | null;
  /** The attempt in progress, if any. */
  inProgress: AttemptSummary | null;
  /** When the next attempt may start, while the retake lock holds; null when it may start now. */
  lockedUntil: Date | null;
  attempts: AttemptSummary[];
  insights: AssessmentInsights;
}

export async function getLearnerAssessment(
  pool: Pick<Pool, "query">,
  subject: string,
  slug: string,
  now = new Date(),
): Promise<LearnerAssessment | null> {
  const found = await openAssessment(pool, slug);
  if (!found) return null;
  await expireStale(pool, subject, found.course.id, now);
  const { rows } = await pool.query<AttemptRow>(
    "SELECT * FROM assessment_attempts WHERE subject = $1 AND course_id = $2 ORDER BY started_at DESC LIMIT 100",
    [subject, found.course.id],
  );
  const submitted = rows.filter((r) => r.submitted_at);
  const lastSubmit = submitted[0]?.submitted_at;
  const until = lastSubmit ? nextAttemptAt(lastSubmit) : null;
  const n = found.settings ? Math.min(found.settings.questionsPerAttempt, found.bank.length) : 0;
  const open = rows.find((r) => !r.submitted_at);
  return {
    course: found.course,
    open: found.settings
      ? { questionsPerAttempt: n, passPercent: found.settings.passPercent, minutes: attemptMinutes(n) }
      : null,
    inProgress: open ? toSummary(open) : null,
    lockedUntil: until && until > now ? until : null,
    attempts: submitted.map(toSummary),
    insights: buildInsights(submitted.map(toGraded)),
  };
}

/** Start (or resume) an attempt. */
export async function startAttempt(
  pool: Pool,
  subject: string,
  slug: string,
  now = new Date(),
  random: () => number = Math.random,
): Promise<AssessmentResult<{ id: string; resumed: boolean }>> {
  const found = await openAssessment(pool, slug);
  if (!found?.settings) return { ok: false, error: "not_open" };
  const { course, settings, bank } = found;
  return inTransaction(pool, async (c) => {
    // One learner's starts one at a time, so two tabs can't both start an attempt.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('knowledge.assessment:' || $1 || ':' || $2))", [
      subject,
      course.id,
    ]);
    await expireStale(c, subject, course.id, now);
    const open = (
      await c.query<{ id: string }>(
        "SELECT id FROM assessment_attempts WHERE subject = $1 AND course_id = $2 AND submitted_at IS NULL",
        [subject, course.id],
      )
    ).rows[0];
    if (open) return { ok: true, id: open.id, resumed: true } as const;
    const past = (
      await c.query<{ submitted_at: Date; questions: AskedQuestion[]; answers: Answers | null }>(
        `SELECT submitted_at, questions, answers FROM assessment_attempts
         WHERE subject = $1 AND course_id = $2 AND submitted_at IS NOT NULL ORDER BY submitted_at DESC LIMIT 20`,
        [subject, course.id],
      )
    ).rows;
    const until = past[0] ? nextAttemptAt(past[0].submitted_at) : null;
    if (until && until > now) return { ok: false, error: "locked", until } as const;
    const history: QuestionHistory = new Map();
    for (const a of past) {
      const g = gradeAttempt(a.questions, a.answers ?? {});
      for (const q of a.questions) {
        const h = history.get(q.id) ?? { asked: 0, missed: 0 };
        h.asked += 1;
        if (!g.perQuestion[q.id]?.correct) h.missed += 1;
        history.set(q.id, h);
      }
    }
    const lessons = new Map(
      course.modules.flatMap((m) => m.lessons.map((l) => [l.lessonId, { title: l.title, module: m.title }] as const)),
    );
    const n = Math.min(settings.questionsPerAttempt, bank.length);
    const asked: AskedQuestion[] = pickQuestions(bank, n, history, random).map((q) => ({
      id: q.id,
      kind: q.kind,
      prompt: q.prompt,
      options: q.options,
      explanation: q.explanation,
      lessonId: q.lessonId,
      lessonTitle: q.lessonId ? (lessons.get(q.lessonId)?.title ?? "") : "",
      moduleTitle: q.lessonId ? (lessons.get(q.lessonId)?.module ?? "") : "",
      difficulty: q.difficulty,
      image: q.image,
    }));
    const id = randomUUID();
    await c.query(
      `INSERT INTO assessment_attempts (id, course_id, subject, started_at, deadline, questions, total, pass_percent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        course.id,
        subject,
        now,
        new Date(now.getTime() + attemptMinutes(n) * 60_000),
        JSON.stringify(asked),
        asked.length,
        settings.passPercent,
      ],
    );
    return { ok: true, id, resumed: false } as const;
  });
}

export interface AttemptView {
  id: string;
  course: { id: string; slug: string; title: string };
  startedAt: Date;
  deadline: Date;
  passPercent: number;
  /** While open: the questions without answers. */
  toAnswer: QuestionToAnswer[] | null;
  /** Once submitted: everything, with the grade. */
  result: {
    submittedAt: Date;
    expired: boolean;
    questions: AskedQuestion[];
    answers: Answers;
    grade: AttemptGrade;
    passed: boolean;
    nextAttemptAt: Date;
  } | null;
}

/** One of the learner's own attempts (anyone else's is "not found"). */
export async function getAttempt(
  pool: Pick<Pool, "query">,
  subject: string,
  attemptId: string,
  now = new Date(),
): Promise<AttemptView | null> {
  await expireStale(pool, subject, null, now);
  const row = (
    await pool.query<AttemptRow & { slug: string }>(
      "SELECT a.*, c.slug FROM assessment_attempts a JOIN courses c ON c.id = a.course_id WHERE a.id = $1 AND a.subject = $2",
      [attemptId, subject],
    )
  ).rows[0];
  if (!row) return null;
  const title = (await getPublishedCourse(pool, row.slug))?.title ?? "Course";
  const answers = row.answers ?? {};
  return {
    id: row.id,
    course: { id: row.course_id, slug: row.slug, title },
    startedAt: row.started_at,
    deadline: row.deadline,
    passPercent: row.pass_percent,
    toAnswer: row.submitted_at ? null : row.questions.map(withoutAnswers),
    result: row.submitted_at
      ? {
          submittedAt: row.submitted_at,
          expired: row.expired,
          questions: row.questions,
          answers,
          grade: gradeAttempt(row.questions, answers),
          passed: (row.score ?? 0) >= row.pass_percent,
          nextAttemptAt: nextAttemptAt(row.submitted_at),
        }
      : null,
  };
}

/** Grade and close an open attempt. Answers after the deadline (beyond the grace) don't count. */
export async function submitAttempt(
  pool: Pool,
  subject: string,
  attemptId: string,
  rawAnswers: unknown,
  now = new Date(),
): Promise<AssessmentResult<{ score: number }>> {
  return inTransaction(pool, async (c) => {
    const row = (
      await c.query<AttemptRow>("SELECT * FROM assessment_attempts WHERE id = $1 AND subject = $2 FOR UPDATE", [
        attemptId,
        subject,
      ])
    ).rows[0];
    if (!row) return { ok: false, error: "not_found" } as const;
    if (row.submitted_at) return { ok: false, error: "attempt_closed" } as const;
    const late = now.getTime() > row.deadline.getTime() + SUBMIT_GRACE_MS;
    const g = await finish(
      c,
      row,
      late ? {} : cleanAnswers(row.questions, rawAnswers),
      late ? row.deadline : now,
      late,
    );
    return { ok: true, score: g.score } as const;
  });
}

export interface MyAssessment {
  slug: string;
  title: string;
  attempts: number;
  best: number;
  latest: number;
  latestAt: Date;
  nextAttemptAt: Date;
}

/** Every course this learner was assessed in, most recent first. */
export async function listMyAssessments(pool: Pick<Pool, "query">, subject: string): Promise<MyAssessment[]> {
  const { rows } = await pool.query<{
    slug: string;
    title: string;
    attempts: number;
    best: number;
    latest: number;
    latest_at: Date;
  }>(
    `SELECT c.slug, coalesce(r.title, c.slug) AS title, count(*)::int AS attempts, max(a.score)::int AS best,
            (array_agg(a.score ORDER BY a.submitted_at DESC))[1]::int AS latest, max(a.submitted_at) AS latest_at
     FROM assessment_attempts a JOIN courses c ON c.id = a.course_id
     LEFT JOIN course_revisions r ON r.id = c.published_revision_id
     WHERE a.subject = $1 AND a.submitted_at IS NOT NULL
     GROUP BY c.slug, r.title ORDER BY latest_at DESC LIMIT 100`,
    [subject],
  );
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    attempts: r.attempts,
    best: r.best,
    latest: r.latest,
    latestAt: r.latest_at,
    nextAttemptAt: nextAttemptAt(r.latest_at),
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Overviews: the studio's Assessments dashboard and the learner's list of assessments to take

export interface StudioAssessmentRow {
  courseId: string;
  slug: string;
  title: string;
  courseStatus: "draft" | "published" | "withdrawn";
  /** null: nobody has started an assessment for this course yet. */
  status: AssessmentStatus | null;
  version: number;
  questionsPerAttempt: number;
  passPercent: number;
  active: number;
  drafts: number;
  attempts: number;
  learners: number;
  /** Mean score of submitted attempts, 0 to 100; null before the first one. */
  average: number | null;
  /** Share of submitted attempts at or above the pass mark they were taken with, 0 to 100. */
  passRate: number | null;
  lastAttemptAt: Date | null;
  updatedAt: Date;
}

/**
 * Every course this person may manage, with its assessment at a glance: their own courses, or every course for
 * someone who manages them all. Courses without an assessment are listed too, so one can be started from here.
 */
export async function listStudioAssessments(pool: Pick<Pool, "query">, actor: Actor): Promise<StudioAssessmentRow[]> {
  if (!canCreateCourse(actor)) return [];
  const { rows } = await pool.query<{
    course_id: string;
    slug: string;
    title: string;
    published_revision_id: string | null;
    withdrawn_at: Date | null;
    status: AssessmentStatus | null;
    version: number | null;
    questions_per_attempt: number | null;
    pass_percent: number | null;
    active: number;
    drafts: number;
    attempts: number;
    learners: number;
    average: number | null;
    passed: number;
    last_attempt_at: Date | null;
    updated_at: Date;
  }>(
    `SELECT c.id AS course_id, c.slug, r.title, c.published_revision_id, c.withdrawn_at,
            a.status, a.version, a.questions_per_attempt, a.pass_percent,
            coalesce(q.active, 0)::int AS active, coalesce(q.drafts, 0)::int AS drafts,
            coalesce(t.attempts, 0)::int AS attempts, coalesce(t.learners, 0)::int AS learners,
            t.average, coalesce(t.passed, 0)::int AS passed, t.last_attempt_at,
            greatest(c.updated_at, a.updated_at) AS updated_at
     FROM courses c
     JOIN course_revisions r ON r.id = c.draft_revision_id
     LEFT JOIN assessments a ON a.course_id = c.id
     LEFT JOIN (
       SELECT course_id, count(*) FILTER (WHERE status = 'active') AS active, count(*) FILTER (WHERE status = 'draft') AS drafts
       FROM assessment_questions GROUP BY course_id
     ) q ON q.course_id = c.id
     LEFT JOIN (
       SELECT course_id, count(*) AS attempts, count(DISTINCT subject) AS learners, round(avg(score))::int AS average,
              count(*) FILTER (WHERE score >= pass_percent) AS passed, max(submitted_at) AS last_attempt_at
       FROM assessment_attempts WHERE submitted_at IS NOT NULL GROUP BY course_id
     ) t ON t.course_id = c.id
     WHERE $1::boolean OR c.owner_subject = $2
     ORDER BY (a.status = 'open') DESC NULLS LAST, (a.course_id IS NOT NULL) DESC, greatest(c.updated_at, a.updated_at) DESC, c.id
     LIMIT 500`,
    [seesAllCourses(actor), actor.subject],
  );
  return rows.map((r) => ({
    courseId: r.course_id,
    slug: r.slug,
    title: r.title,
    courseStatus: r.published_revision_id ? "published" : r.withdrawn_at ? "withdrawn" : "draft",
    status: r.status,
    version: r.version ?? 0,
    questionsPerAttempt: r.questions_per_attempt ?? DEFAULT_SETTINGS.questionsPerAttempt,
    passPercent: r.pass_percent ?? DEFAULT_SETTINGS.passPercent,
    active: r.active,
    drafts: r.drafts,
    attempts: r.attempts,
    learners: r.learners,
    average: r.attempts ? r.average : null,
    passRate: r.attempts ? Math.round((100 * r.passed) / r.attempts) : null,
    lastAttemptAt: r.last_attempt_at,
    updatedAt: r.updated_at,
  }));
}

export interface AvailableAssessment {
  slug: string;
  title: string;
  /** Questions an attempt asks. */
  questions: number;
}

/** Published courses whose assessment a signed-in learner can take now, by course title. */
export async function listAvailableAssessments(pool: Pick<Pool, "query">): Promise<AvailableAssessment[]> {
  const { rows } = await pool.query<{ slug: string; title: string }>(
    `SELECT c.slug, r.title FROM assessments a
     JOIN courses c ON c.id = a.course_id JOIN course_revisions r ON r.id = c.published_revision_id
     WHERE a.status = 'open'
       AND (SELECT count(*) FROM assessment_questions q WHERE q.course_id = a.course_id AND q.status = 'active') >= $1
     ORDER BY lower(r.title), c.slug LIMIT 100`,
    [ASSESSMENT_LIMITS.minPerAttempt],
  );
  // The course page's own check (only questions about lessons that are public now) decides the final count.
  const found = await Promise.all(rows.map(async (r) => ({ ...r, teaser: await assessmentTeaser(pool, r.slug) })));
  return found.flatMap((f) => (f.teaser ? [{ slug: f.slug, title: f.title, questions: f.teaser.questions }] : []));
}
