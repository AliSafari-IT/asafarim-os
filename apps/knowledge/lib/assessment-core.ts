/**
 * Course assessments, the pure part: the shape and limits of a question, grading, which questions an attempt asks,
 * the retake lock and the learner's insights (where to study more). No database and no server-only imports, so the
 * browser (the question editor, the runner) and the unit tests use exactly the rules the server applies.
 */

export const QUESTION_KINDS = ["single", "multiple"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export type QuestionStatus = "draft" | "active";
export type QuestionSource = "author" | "ai";

export const ASSESSMENT_LIMITS = {
  /** Questions one attempt asks, and that one AI generation writes. */
  minPerAttempt: 3,
  maxPerAttempt: 30,
  /** Questions in one course's bank. */
  bank: 300,
  prompt: 1000,
  option: 300,
  minOptions: 2,
  maxOptions: 6,
  explanation: 2000,
  imageAlt: 200,
} as const;

/** Days a learner waits after submitting an attempt before the next one. */
export const RETAKE_DAYS = 3;
const DAY_MS = 24 * 3600_000;

/** Minutes an attempt stays open: two a question, at least ten. Past it (and a short grace) it is graded as it stands. */
export const attemptMinutes = (questions: number) => Math.max(10, questions * 2);
/** Late answers still count for this long after the deadline (a slow network on the automatic submit). */
export const SUBMIT_GRACE_MS = 2 * 60_000;

/** When a learner may start again, after submitting at `submittedAt`. */
export const nextAttemptAt = (submittedAt: Date) => new Date(submittedAt.getTime() + RETAKE_DAYS * DAY_MS);

export interface QuestionOption {
  /** Stable within the question, so an edit of one option's text keeps the others' ids. */
  id: string;
  text: string;
  correct: boolean;
}

export interface QuestionImage {
  /** An https address on another site, SVG code, or an uploaded image (its media asset id): at most one. */
  url: string;
  svg: string;
  assetId: string | null;
  alt: string;
}

export const NO_IMAGE: QuestionImage = { url: "", svg: "", assetId: null, alt: "" };

/** What an author writes (or the AI proposes) for one question. */
export interface QuestionInput {
  kind: QuestionKind;
  prompt: string;
  options: QuestionOption[];
  explanation: string;
  lessonId: string | null;
  difficulty: Difficulty;
  image: QuestionImage;
}

export interface Question extends QuestionInput {
  id: string;
  position: number;
  status: QuestionStatus;
  source: QuestionSource;
}

/** One question as an attempt asked it: a copy, so later edits never change a past result. */
export interface AskedQuestion {
  id: string;
  kind: QuestionKind;
  prompt: string;
  /** In the order this attempt showed them (shuffled at the start). */
  options: QuestionOption[];
  explanation: string;
  lessonId: string | null;
  lessonTitle: string;
  moduleTitle: string;
  difficulty: Difficulty;
  image: QuestionImage;
}

/** An asked question without its answers: what the browser gets while the attempt is open. */
export type QuestionToAnswer = Omit<AskedQuestion, "options" | "explanation"> & {
  options: { id: string; text: string }[];
};

export const withoutAnswers = (q: AskedQuestion): QuestionToAnswer => ({
  id: q.id,
  kind: q.kind,
  prompt: q.prompt,
  options: q.options.map((o) => ({ id: o.id, text: o.text })),
  lessonId: q.lessonId,
  lessonTitle: q.lessonTitle,
  moduleTitle: q.moduleTitle,
  difficulty: q.difficulty,
  image: q.image,
});

/** Text of a prompt, option or explanation: line breaks kept (at most one blank line), spaces tidied, ends trimmed. */
export const cleanQuestionText = (s: string) =>
  s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export type QuestionError =
  | "question_prompt"
  | "question_options"
  | "question_option_text"
  | "question_correct_single"
  | "question_correct_multiple"
  | "question_duplicate_options"
  | "question_explanation"
  | "question_kind"
  | "question_difficulty"
  | "question_image_alt";

/** Tidy and check a question's text, options and answers (the picture's source and the lesson are checked by the caller). */
export function checkQuestion(
  input: QuestionInput,
): { ok: true; question: QuestionInput } | { ok: false; error: QuestionError } {
  const L = ASSESSMENT_LIMITS;
  if (!(QUESTION_KINDS as readonly string[]).includes(input.kind)) return { ok: false, error: "question_kind" };
  if (!(DIFFICULTIES as readonly string[]).includes(input.difficulty))
    return { ok: false, error: "question_difficulty" };
  const prompt = cleanQuestionText(input.prompt ?? "");
  if (!prompt || prompt.length > L.prompt) return { ok: false, error: "question_prompt" };
  const raw = Array.isArray(input.options) ? input.options : [];
  const options = raw
    .map((o) => ({
      id: String(o?.id ?? ""),
      text: cleanQuestionText(String(o?.text ?? "")),
      correct: o?.correct === true,
    }))
    .filter((o) => o.text);
  if (options.length < L.minOptions || options.length > L.maxOptions) return { ok: false, error: "question_options" };
  if (options.some((o) => o.text.length > L.option || !/^[a-z0-9-]{1,40}$/i.test(o.id)))
    return { ok: false, error: "question_option_text" };
  const texts = new Set(options.map((o) => o.text.toLowerCase()));
  const ids = new Set(options.map((o) => o.id));
  if (texts.size !== options.length || ids.size !== options.length)
    return { ok: false, error: "question_duplicate_options" };
  const correct = options.filter((o) => o.correct).length;
  if (input.kind === "single" && correct !== 1) return { ok: false, error: "question_correct_single" };
  if (input.kind === "multiple" && correct < 1) return { ok: false, error: "question_correct_multiple" };
  const explanation = cleanQuestionText(input.explanation ?? "");
  if (explanation.length > L.explanation) return { ok: false, error: "question_explanation" };
  const alt = (input.image?.alt ?? "").replace(/\s+/g, " ").trim();
  if (alt.length > L.imageAlt) return { ok: false, error: "question_image_alt" };
  return {
    ok: true,
    question: { ...input, prompt, options, explanation, image: { ...(input.image ?? NO_IMAGE), alt } },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Grading

export interface QuestionGrade {
  /** 0..1. Single answer: 1 or 0. Several correct: (right picks - wrong picks) / correct options, at least 0. */
  points: number;
  /** Exactly the correct options were chosen. */
  correct: boolean;
}

export function gradeQuestion(q: Pick<AskedQuestion, "kind" | "options">, chosen: readonly string[]): QuestionGrade {
  const valid = new Set(q.options.map((o) => o.id));
  const picks = new Set(chosen.filter((id) => valid.has(id)));
  const right = new Set(q.options.filter((o) => o.correct).map((o) => o.id));
  const exact = picks.size === right.size && [...picks].every((id) => right.has(id));
  if (q.kind === "single") return { points: exact ? 1 : 0, correct: exact };
  if (!right.size) return { points: 0, correct: false };
  const hits = [...picks].filter((id) => right.has(id)).length;
  const misses = picks.size - hits;
  return { points: Math.max(0, (hits - misses) / right.size), correct: exact };
}

export type Answers = Record<string, string[]>;

/** Keep only answers to asked questions and options they have; a single-answer question keeps one pick. */
export function cleanAnswers(questions: readonly AskedQuestion[], raw: unknown): Answers {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Answers = {};
  for (const q of questions) {
    const v = input[q.id];
    if (!Array.isArray(v)) continue;
    const ids = q.options.map((o) => o.id);
    const picks = [...new Set(v.filter((x): x is string => typeof x === "string" && ids.includes(x)))];
    if (picks.length) out[q.id] = q.kind === "single" ? picks.slice(0, 1) : picks;
  }
  return out;
}

export interface AttemptGrade {
  points: number;
  correct: number;
  total: number;
  /** Rounded percentage of points. */
  score: number;
  perQuestion: Record<string, QuestionGrade>;
}

export function gradeAttempt(questions: readonly AskedQuestion[], answers: Answers): AttemptGrade {
  const perQuestion: Record<string, QuestionGrade> = {};
  let points = 0;
  let correct = 0;
  for (const q of questions) {
    const g = gradeQuestion(q, answers[q.id] ?? []);
    perQuestion[q.id] = g;
    points += g.points;
    if (g.correct) correct += 1;
  }
  const total = questions.length;
  return {
    points: Math.round(points * 100) / 100,
    correct,
    total,
    score: total ? Math.round((points / total) * 100) : 0,
    perQuestion,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Which questions an attempt asks

/** How this learner did on a question before: what makes the next attempt adaptive. */
export type QuestionHistory = Map<string, { asked: number; missed: number }>;

/**
 * Pick `n` questions: first one from each lesson (in random order) so the attempt covers the course, then the rest
 * weighted towards what this learner needs: questions they missed before (x3) and ones they haven't seen (x2) come
 * up more than ones they already got right (x1). Options are shuffled too. `random` returns [0, 1).
 */
export function pickQuestions<Q extends { id: string; lessonId: string | null; options: QuestionOption[] }>(
  bank: readonly Q[],
  n: number,
  history: QuestionHistory = new Map(),
  random: () => number = Math.random,
): Q[] {
  const count = Math.min(Math.max(0, Math.floor(n)), bank.length);
  const weight = (q: Q) => {
    const h = history.get(q.id);
    if (!h || h.asked === 0) return 2;
    return h.missed > 0 ? 3 : 1;
  };
  const shuffle = <T>(xs: T[]) => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
    return xs;
  };
  /** One weighted draw without replacement. */
  const draw = (pool: Q[]): Q => {
    const total = pool.reduce((s, q) => s + weight(q), 0);
    let r = random() * total;
    for (const [i, q] of pool.entries()) {
      r -= weight(q);
      if (r < 0) return pool.splice(i, 1)[0]!;
    }
    return pool.pop()!;
  };
  const remaining = [...bank];
  const chosen: Q[] = [];
  const byLesson = new Map<string, Q[]>();
  for (const q of remaining) {
    const key = q.lessonId ?? "";
    byLesson.set(key, [...(byLesson.get(key) ?? []), q]);
  }
  for (const key of shuffle([...byLesson.keys()])) {
    if (chosen.length >= count) break;
    const q = draw([...byLesson.get(key)!]);
    chosen.push(q);
    remaining.splice(remaining.indexOf(q), 1);
  }
  while (chosen.length < count) chosen.push(draw(remaining));
  return shuffle(chosen).map((q) => ({ ...q, options: shuffle([...q.options]) }));
}

// ---------------------------------------------------------------------------------------------------------------
// Insights: where to study more

export interface GradedAttempt {
  id: string;
  submittedAt: Date;
  score: number;
  questions: AskedQuestion[];
  answers: Answers;
}

export type MasteryLevel = "strong" | "developing" | "needs_work";

export interface AreaInsight {
  /** The lesson id, or "" for questions about the course in general; for a module, its title. */
  key: string;
  title: string;
  moduleTitle: string;
  lessonId: string | null;
  /** 0..100: points on this area's questions, recent attempts weighing more. */
  mastery: number;
  level: MasteryLevel;
  /** Questions asked about it, over all attempts. */
  asked: number;
  /** The newest attempt's score on it, and the one before (null when not asked then): the trend. */
  latest: number | null;
  previous: number | null;
}

export interface AssessmentInsights {
  attempts: number;
  best: number | null;
  latest: number | null;
  /** Oldest first, for the trend chart. */
  history: { id: string; submittedAt: Date; score: number }[];
  modules: AreaInsight[];
  lessons: AreaInsight[];
  /** Up to five lessons to study next, weakest first. */
  focus: AreaInsight[];
  byDifficulty: { difficulty: Difficulty; asked: number; percent: number }[];
  byKind: { kind: QuestionKind; asked: number; percent: number }[];
}

/** Each older attempt counts this much less than the next newer one. */
const RECENCY = 0.6;

export const levelOf = (mastery: number): MasteryLevel =>
  mastery >= 85 ? "strong" : mastery >= 60 ? "developing" : "needs_work";

export function buildInsights(attemptsAnyOrder: readonly GradedAttempt[]): AssessmentInsights {
  const attempts = [...attemptsAnyOrder].sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());
  type Acc = {
    title: string;
    moduleTitle: string;
    lessonId: string | null;
    w: number;
    wp: number;
    asked: number;
    perAttempt: Map<number, { p: number; n: number }>;
  };
  const lessons = new Map<string, Acc>();
  const modules = new Map<string, Acc>();
  const diff = new Map<Difficulty, { p: number; n: number }>();
  const kinds = new Map<QuestionKind, { p: number; n: number }>();
  const add = (
    map: Map<string, Acc>,
    key: string,
    seed: Omit<Acc, "w" | "wp" | "asked" | "perAttempt">,
    k: number,
    p: number,
  ) => {
    const acc = map.get(key) ?? { ...seed, w: 0, wp: 0, asked: 0, perAttempt: new Map() };
    const w = RECENCY ** k;
    acc.w += w;
    acc.wp += w * p;
    acc.asked += 1;
    const pa = acc.perAttempt.get(k) ?? { p: 0, n: 0 };
    pa.p += p;
    pa.n += 1;
    acc.perAttempt.set(k, pa);
    map.set(key, acc);
  };
  attempts.forEach((a, k) => {
    for (const q of a.questions) {
      const p = gradeQuestion(q, a.answers[q.id] ?? []).points;
      const moduleTitle = q.moduleTitle || "General";
      add(
        lessons,
        q.lessonId ?? "",
        { title: q.lessonId ? q.lessonTitle : "The course in general", moduleTitle, lessonId: q.lessonId },
        k,
        p,
      );
      add(modules, moduleTitle, { title: moduleTitle, moduleTitle, lessonId: null }, k, p);
      for (const [map, key] of [
        [diff, q.difficulty],
        [kinds, q.kind],
      ] as const) {
        const m = map as Map<string, { p: number; n: number }>;
        const v = m.get(key) ?? { p: 0, n: 0 };
        v.p += p;
        v.n += 1;
        m.set(key, v);
      }
    }
  });
  const pct = (v: { p: number; n: number } | undefined) => (v && v.n ? Math.round((v.p / v.n) * 100) : null);
  const toArea = ([key, a]: [string, Acc]): AreaInsight => {
    const mastery = Math.round((a.wp / a.w) * 100);
    return {
      key,
      title: a.title,
      moduleTitle: a.moduleTitle,
      lessonId: a.lessonId,
      mastery,
      level: levelOf(mastery),
      asked: a.asked,
      latest: pct(a.perAttempt.get(0)),
      previous: pct(a.perAttempt.get(1)),
    };
  };
  const lessonAreas = [...lessons].map(toArea);
  const moduleAreas = [...modules].map(toArea);
  return {
    attempts: attempts.length,
    best: attempts.length ? Math.max(...attempts.map((a) => a.score)) : null,
    latest: attempts[0]?.score ?? null,
    history: [...attempts].reverse().map((a) => ({ id: a.id, submittedAt: a.submittedAt, score: a.score })),
    modules: moduleAreas,
    lessons: lessonAreas,
    focus: lessonAreas
      .filter((l) => l.mastery < 70)
      .sort((a, b) => a.mastery - b.mastery || b.asked - a.asked)
      .slice(0, 5),
    byDifficulty: DIFFICULTIES.filter((d) => diff.has(d)).map((d) => ({
      difficulty: d,
      asked: diff.get(d)!.n,
      percent: pct(diff.get(d))!,
    })),
    byKind: QUESTION_KINDS.filter((k) => kinds.has(k)).map((k) => ({
      kind: k,
      asked: kinds.get(k)!.n,
      percent: pct(kinds.get(k))!,
    })),
  };
}

/** For an attempt's result page: each module's and lesson's score in that one attempt. */
export function attemptBreakdown(questions: readonly AskedQuestion[], answers: Answers) {
  return buildInsights([{ id: "x", submittedAt: new Date(0), score: 0, questions: [...questions], answers }]);
}
