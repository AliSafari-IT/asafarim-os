"use client";
/**
 * Taking an attempt: one question at a time, a palette to jump between them (answered, flagged for review), the time
 * left, and a review step before submitting. Answers are kept in this tab (sessionStorage) so a reload loses nothing;
 * nothing is graded here: the browser never has the answers. When the time is up the attempt is submitted as it is.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { submitAttemptAction } from "@/app/courses/assessment-actions";
import type { QuestionToAnswer } from "@/lib/assessment-core";
import { ERRORS } from "@/lib/messages";
import { QuestionImage } from "./QuestionImage";

type Answers = Record<string, string[]>;
const key = (attemptId: string) => `knowledge.assessment.${attemptId}`;

function load(attemptId: string): { answers: Answers; flagged: string[] } {
  try {
    const v = JSON.parse(sessionStorage.getItem(key(attemptId)) ?? "null") as unknown;
    if (v && typeof v === "object" && "answers" in v) return v as { answers: Answers; flagged: string[] };
  } catch {
    // Storage blocked or unreadable: start empty.
  }
  return { answers: {}, flagged: [] };
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function AssessmentRunner(props: {
  slug: string;
  attemptId: string;
  questions: QuestionToAnswer[];
  deadline: string;
}) {
  const { questions } = props;
  const [answers, setAnswers] = useState<Answers>({});
  const [flagged, setFlagged] = useState<string[]>([]);
  const [at, setAt] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const submitted = useRef(false);
  const deadline = useMemo(() => new Date(props.deadline).getTime(), [props.deadline]);

  useEffect(() => {
    const saved = load(props.attemptId);
    setAnswers(saved.answers);
    setFlagged(saved.flagged);
  }, [props.attemptId]);
  useEffect(() => {
    try {
      sessionStorage.setItem(key(props.attemptId), JSON.stringify({ answers, flagged }));
    } catch {
      // Not kept across a reload; the attempt still works.
    }
  }, [answers, flagged, props.attemptId]);

  const submit = useCallback(() => {
    if (submitted.current) return;
    submitted.current = true;
    startTransition(async () => {
      const r = await submitAttemptAction(props.slug, props.attemptId, answers);
      // Only a failure comes back: success navigates to the result.
      submitted.current = false;
      if (r && !r.ok) setError(ERRORS[r.error] ?? "The attempt couldn't be submitted. Try again.");
    });
  }, [answers, props.attemptId, props.slug]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = deadline - now;
  useEffect(() => {
    if (left <= 0) submit();
  }, [left, submit]);

  const q = questions[at]!;
  const chosen = answers[q.id] ?? [];
  const answered = questions.filter((x) => (answers[x.id] ?? []).length > 0).length;
  const choose = (optionId: string) =>
    setAnswers((a) => {
      const cur = a[q.id] ?? [];
      const next =
        q.kind === "single"
          ? [optionId]
          : cur.includes(optionId)
            ? cur.filter((x) => x !== optionId)
            : [...cur, optionId];
      return { ...a, [q.id]: next };
    });
  const toggleFlag = () => setFlagged((f) => (f.includes(q.id) ? f.filter((x) => x !== q.id) : [...f, q.id]));
  const go = (i: number) => {
    setReviewing(false);
    setAt(Math.min(Math.max(0, i), questions.length - 1));
  };

  // Keys: ← → between questions, 1-6 to choose an option.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (reviewing || t?.closest("textarea, input[type=text]")) return;
      if (e.key === "ArrowRight") go(at + 1);
      else if (e.key === "ArrowLeft") go(at - 1);
      else if (/^[1-6]$/.test(e.key)) {
        const o = q.options[Number(e.key) - 1];
        if (o) choose(o.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const lowTime = left < 60_000;
  return (
    <div className="runner" data-testid="assessment-runner">
      <div className="runner-bar">
        <div className="runner-progress" aria-label={`${answered} of ${questions.length} answered`}>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${(answered / questions.length) * 100}%` }} />
          </div>
          <span className="muted">
            {answered} of {questions.length} answered
          </span>
        </div>
        <span
          className={lowTime ? "runner-clock low" : "runner-clock"}
          role="timer"
          aria-live={lowTime ? "polite" : "off"}
        >
          ⏱ {clock(left)}
        </span>
      </div>

      <nav className="runner-palette" aria-label="Questions">
        {questions.map((x, i) => {
          const done = (answers[x.id] ?? []).length > 0;
          const flag = flagged.includes(x.id);
          return (
            <button
              key={x.id}
              type="button"
              className={[
                "palette-dot",
                done ? "done" : "",
                flag ? "flagged" : "",
                i === at && !reviewing ? "current" : "",
              ].join(" ")}
              onClick={() => go(i)}
              aria-label={`Question ${i + 1}${done ? ", answered" : ""}${flag ? ", flagged" : ""}`}
              aria-current={i === at && !reviewing ? "step" : undefined}
            >
              {i + 1}
            </button>
          );
        })}
      </nav>

      {reviewing ? (
        <section className="card runner-review" data-testid="runner-review">
          <h2>Ready to submit?</h2>
          <p>
            You answered <strong>{answered}</strong> of {questions.length} questions.
            {answered < questions.length ? " Unanswered questions score nothing." : ""}
            {flagged.length ? ` ${flagged.length} flagged for review.` : ""}
          </p>
          <ul className="review-list">
            {questions.map((x, i) =>
              (answers[x.id] ?? []).length === 0 || flagged.includes(x.id) ? (
                <li key={x.id}>
                  <button type="button" className="link-button" onClick={() => go(i)}>
                    Question {i + 1}
                  </button>{" "}
                  <span className="muted">{(answers[x.id] ?? []).length === 0 ? "not answered" : "flagged"}</span>
                </li>
              ) : null,
            )}
          </ul>
          <p className="muted">Once submitted, you can take the assessment again after 3 days.</p>
          {error ? (
            <p className="notice bad" role="alert">
              {error}
            </p>
          ) : null}
          <div className="actions">
            <button type="button" onClick={submit} disabled={pending} data-testid="submit-attempt">
              {pending ? "Submitting…" : "Submit my answers"}
            </button>
            <button type="button" className="secondary" onClick={() => go(at)}>
              Back to the questions
            </button>
          </div>
        </section>
      ) : (
        <section className="card runner-question" aria-labelledby={`q-${q.id}`} data-testid="runner-question">
          <p className="eyebrow">
            Question {at + 1} of {questions.length}
            {q.moduleTitle ? ` · ${q.moduleTitle}` : ""}
          </p>
          <h2 id={`q-${q.id}`} className="runner-prompt">
            {q.prompt}
          </h2>
          <p className="muted">{q.kind === "single" ? "Choose one answer." : "Choose every correct answer."}</p>
          <QuestionImage image={q.image} />
          <fieldset className="runner-options">
            <legend className="sr-only">{q.prompt}</legend>
            {q.options.map((o, i) => {
              const on = chosen.includes(o.id);
              return (
                <label key={o.id} className={on ? "runner-option chosen" : "runner-option"} data-testid="runner-option">
                  <input
                    type={q.kind === "single" ? "radio" : "checkbox"}
                    name={`q-${q.id}`}
                    checked={on}
                    onChange={() => choose(o.id)}
                  />
                  <span className="option-key" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span>{o.text}</span>
                </label>
              );
            })}
          </fieldset>
          <div className="runner-nav">
            <button type="button" className="secondary" onClick={() => go(at - 1)} disabled={at === 0}>
              ← Previous
            </button>
            <button
              type="button"
              className={flagged.includes(q.id) ? "secondary flag on" : "secondary flag"}
              onClick={toggleFlag}
              aria-pressed={flagged.includes(q.id)}
            >
              ⚑ {flagged.includes(q.id) ? "Flagged" : "Flag for review"}
            </button>
            {at < questions.length - 1 ? (
              <button type="button" onClick={() => go(at + 1)} data-testid="next-question">
                Next →
              </button>
            ) : (
              <button type="button" onClick={() => setReviewing(true)} data-testid="review-attempt">
                Review and submit
              </button>
            )}
          </div>
          <p className="muted runner-keys">
            Keys: <kbd>←</kbd> <kbd>→</kbd> move, <kbd>1</kbd>–<kbd>{q.options.length}</kbd> choose.
          </p>
        </section>
      )}
    </div>
  );
}
