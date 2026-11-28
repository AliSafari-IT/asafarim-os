import { describe, expect, it } from "vitest";
import {
  attemptBreakdown,
  buildInsights,
  checkQuestion,
  cleanAnswers,
  gradeAttempt,
  gradeQuestion,
  nextAttemptAt,
  NO_IMAGE,
  pickQuestions,
  RETAKE_DAYS,
  withoutAnswers,
  type AskedQuestion,
  type QuestionInput,
} from "../lib/assessment-core";

const opts = (correct: number[], n = 4) =>
  Array.from({ length: n }, (_, i) => ({ id: `o${i + 1}`, text: `Option ${i + 1}`, correct: correct.includes(i + 1) }));

const input = (over: Partial<QuestionInput> = {}): QuestionInput => ({
  kind: "single",
  prompt: "  What does  `await` do? ",
  options: opts([2]),
  explanation: "",
  lessonId: null,
  difficulty: "medium",
  image: NO_IMAGE,
  ...over,
});

const asked = (id: string, lessonId: string | null, over: Partial<AskedQuestion> = {}): AskedQuestion => ({
  id,
  kind: "single",
  prompt: id,
  options: opts([1]),
  explanation: "",
  lessonId,
  lessonTitle: lessonId ? `Lesson ${lessonId}` : "",
  moduleTitle: lessonId ? `Module of ${lessonId}` : "",
  difficulty: "medium",
  image: NO_IMAGE,
  ...over,
});

describe("checkQuestion", () => {
  it("tidies text and drops empty options", () => {
    const r = checkQuestion(input({ options: [...opts([2]), { id: "o9", text: "  ", correct: false }] }));
    expect(r.ok && r.question.prompt).toBe("What does `await` do?");
    expect(r.ok && r.question.options).toHaveLength(4);
  });

  it.each([
    [{ prompt: "" }, "question_prompt"],
    [{ options: opts([1], 1) }, "question_options"],
    [{ options: opts([1], 7) }, "question_options"],
    [{ options: opts([1, 2]) }, "question_correct_single"],
    [{ options: opts([]) }, "question_correct_single"],
    [{ kind: "multiple" as const, options: opts([]) }, "question_correct_multiple"],
    [{ options: [...opts([1], 2), { id: "o3", text: "option 1", correct: false }] }, "question_duplicate_options"],
    [{ explanation: "x".repeat(2001) }, "question_explanation"],
  ])("refuses %j", (over, error) => {
    expect(checkQuestion(input(over as Partial<QuestionInput>))).toEqual({ ok: false, error });
  });

  it("accepts several correct options on a multiple-correct question", () => {
    expect(checkQuestion(input({ kind: "multiple", options: opts([1, 3]) })).ok).toBe(true);
  });
});

describe("grading", () => {
  it("single answer: all or nothing", () => {
    const q = { kind: "single" as const, options: opts([2]) };
    expect(gradeQuestion(q, ["o2"])).toEqual({ points: 1, correct: true });
    expect(gradeQuestion(q, ["o1"])).toEqual({ points: 0, correct: false });
    expect(gradeQuestion(q, [])).toEqual({ points: 0, correct: false });
  });

  it("multiple correct: partial credit, wrong picks cancel right ones", () => {
    const q = { kind: "multiple" as const, options: opts([1, 2, 3], 5) };
    expect(gradeQuestion(q, ["o1", "o2", "o3"])).toEqual({ points: 1, correct: true });
    expect(gradeQuestion(q, ["o1", "o2"]).points).toBeCloseTo(2 / 3);
    expect(gradeQuestion(q, ["o1", "o2", "o4"]).points).toBeCloseTo(1 / 3);
    // Ticking everything isn't a strategy.
    expect(gradeQuestion(q, ["o1", "o2", "o3", "o4", "o5"]).points).toBeCloseTo(1 / 3);
    expect(gradeQuestion(q, ["o4", "o5"]).points).toBe(0);
    expect(gradeQuestion(q, ["nope"]).points).toBe(0);
  });

  it("grades an attempt and keeps only valid answers", () => {
    const qs = [asked("a", "l1"), asked("b", "l1", { kind: "multiple", options: opts([1, 2]) }), asked("c", null)];
    const answers = cleanAnswers(qs, { a: ["o1", "o2"], b: ["o1", "x"], c: "o1", z: ["o1"] });
    expect(answers).toEqual({ a: ["o1"], b: ["o1"] });
    const g = gradeAttempt(qs, answers);
    expect(g).toMatchObject({ correct: 1, total: 3, points: 1.5, score: 50 });
  });

  it("never sends the answers while an attempt is open", () => {
    const q = withoutAnswers(asked("a", "l1", { explanation: "because" }));
    expect(JSON.stringify(q)).not.toContain("correct");
    expect(JSON.stringify(q)).not.toContain("because");
  });
});

describe("retake lock", () => {
  it("is three days", () => {
    expect(RETAKE_DAYS).toBe(3);
    expect(nextAttemptAt(new Date("2026-11-28T10:00:00Z")).toISOString()).toBe("2026-12-01T10:00:00.000Z");
  });
});

describe("pickQuestions", () => {
  const seq = (...xs: number[]) => {
    let i = 0;
    return () => xs[i++ % xs.length]!;
  };
  const bank = ["l1", "l1", "l1", "l2", "l3", "l3"].map((l, i) => ({ id: `q${i}`, lessonId: l, options: opts([1]) }));

  it("covers every lesson before repeating one", () => {
    for (let run = 0; run < 20; run++) {
      const picked = pickQuestions(bank, 3, new Map(), Math.random);
      expect(new Set(picked.map((q) => q.lessonId))).toEqual(new Set(["l1", "l2", "l3"]));
    }
  });

  it("never asks more than the bank has, and never the same question twice", () => {
    const picked = pickQuestions(bank, 30, new Map(), seq(0.3, 0.7, 0.1));
    expect(picked).toHaveLength(6);
    expect(new Set(picked.map((q) => q.id)).size).toBe(6);
  });

  it("leans towards questions the learner missed", () => {
    const big = Array.from({ length: 10 }, (_, i) => ({ id: `q${i}`, lessonId: "l1", options: opts([1]) }));
    const history = new Map(big.map((q, i) => [q.id, { asked: 1, missed: i === 7 ? 1 : 0 }]));
    let missedPicked = 0;
    for (let run = 0; run < 400; run++) if (pickQuestions(big, 2, history).some((q) => q.id === "q7")) missedPicked++;
    // Weight 3 out of 12 per draw (vs 1 of 10 uniformly): clearly more than the ~20% a uniform pick gives.
    expect(missedPicked / 400).toBeGreaterThan(0.35);
  });

  it("shuffles the options too", () => {
    const seen = new Set<string>();
    for (let run = 0; run < 30; run++)
      seen.add(
        pickQuestions(bank.slice(0, 1), 1)[0]!
          .options.map((o) => o.id)
          .join(),
      );
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("insights", () => {
  const at = (d: string) => new Date(`2026-11-${d}T10:00:00Z`);
  const qs = [asked("a", "l1"), asked("b", "l1"), asked("c", "l2"), asked("d", null)];

  it("finds the weak lessons, weighting recent attempts more", () => {
    const old = {
      id: "1",
      submittedAt: at("01"),
      score: 25,
      questions: qs,
      answers: { a: ["o2"], b: ["o2"], c: ["o1"] },
    };
    const recent = {
      id: "2",
      submittedAt: at("10"),
      score: 75,
      questions: qs,
      answers: { a: ["o1"], b: ["o1"], c: ["o2"], d: ["o1"] },
    };
    const ins = buildInsights([recent, old]);
    expect(ins.attempts).toBe(2);
    expect(ins.latest).toBe(75);
    expect(ins.best).toBe(75);
    expect(ins.history.map((h) => h.id)).toEqual(["1", "2"]);
    const l1 = ins.lessons.find((l) => l.key === "l1")!;
    const l2 = ins.lessons.find((l) => l.key === "l2")!;
    // l1: 0% then 100%; the newer weighs 1, the older 0.6 → 62.5%. l2: 100% then 0% → 37.5% (floating point rounds it down).
    expect(l1.mastery).toBe(63);
    expect(l1).toMatchObject({ latest: 100, previous: 0, level: "developing" });
    expect(l2.mastery).toBe(37);
    expect(ins.focus.map((f) => f.key)).toEqual(["l2", "l1", ""]);
    expect(ins.lessons.find((l) => l.key === "")!.title).toBe("The course in general");
    expect(ins.modules.map((m) => m.title).sort()).toEqual(["General", "Module of l1", "Module of l2"]);
    expect(ins.byKind).toEqual([{ kind: "single", asked: 8, percent: 50 }]);
  });

  it("an attempt's own breakdown", () => {
    const b = attemptBreakdown(qs, { a: ["o1"], b: ["o2"] });
    expect(b.lessons.find((l) => l.key === "l1")!.mastery).toBe(50);
    expect(b.focus.map((f) => f.key)).toEqual(["l2", "", "l1"]);
  });
});
