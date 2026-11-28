/**
 * A course's assessment in the studio: open it to learners (and how many questions an attempt asks, the pass mark),
 * generate questions with AI from the lessons, write and edit them by hand, approve or delete them, and see how
 * learners do on each one. Only the course's owner, or someone who manages every course, gets here (else a 404).
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { bankAction, saveSettingsAction } from "../../../assessment-actions";
import { GenerateQuestionsForm } from "@/components/GenerateQuestionsForm";
import { Notices } from "@/components/Notices";
import { QuestionEditor, type LessonChoice } from "@/components/QuestionEditor";
import { QuestionImage } from "@/components/QuestionImage";
import { TopBar } from "@/components/TopBar";
import { aiConfigFromEnv } from "@/lib/ai/provider";
import { ASSESSMENT_LIMITS, RETAKE_DAYS } from "@/lib/assessment-core";
import { getStudioAssessment } from "@/lib/assessments";
import { getStudioCourse } from "@/lib/courses";
import { db } from "@/lib/db";
import { one, type SearchParams } from "@/lib/params";
import { requireStudio } from "@/lib/studio";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> };

const DIFFICULTY_LABEL = { easy: "Easy", medium: "Medium", hard: "Hard" } as const;

export default async function StudioAssessmentPage({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const g = await requireStudio();
  if (!g.ok) {
    return (
      <>
        <TopBar next="/studio/courses" />
        <main>
          <Notices error={g.error} />
        </main>
      </>
    );
  }
  const pool = await db();
  const [course, assessment] = await Promise.all([
    getStudioCourse(pool, g.actor, id),
    getStudioAssessment(pool, g.actor, id),
  ]);
  if (!course || !assessment) notFound();
  const lessons: LessonChoice[] = course.modules.flatMap((m) =>
    m.lessons.map((l) => ({ lessonId: l.lessonId, title: l.title, moduleTitle: m.title })),
  );
  const lessonTitle = new Map(lessons.map((l) => [l.lessonId, l]));
  const { settings, questions } = assessment;
  const active = questions.filter((q) => q.status === "active").length;
  const drafts = questions.length - active;

  const filterLesson = one(sp.lesson) ?? "";
  const filterStatus = one(sp.status) ?? "";
  const shown = questions.filter(
    (q) =>
      (!filterLesson || (filterLesson === "general" ? !q.lessonId : q.lessonId === filterLesson)) &&
      (!filterStatus || q.status === filterStatus),
  );
  const editing = one(sp.edit);
  const editQuestion = editing ? questions.find((q) => q.id === editing) : undefined;
  const creating = one(sp.new) === "1";
  const generated = Number(one(sp.generated) ?? "");
  const base = `/studio/courses/${course.id}/assessment`;
  const filterHref = (p: Record<string, string>) => {
    const q = new URLSearchParams({
      ...(filterLesson ? { lesson: filterLesson } : {}),
      ...(filterStatus ? { status: filterStatus } : {}),
      ...p,
    });
    for (const [k, v] of [...q]) if (!v) q.delete(k);
    return `${base}?${q}#questions`;
  };

  /** A one-button form for a bank change. */
  const Op = (p: {
    op: string;
    label: string;
    question?: string;
    className?: string;
    testid?: string;
    title?: string;
  }) => (
    <form action={bankAction} className="inline">
      <input type="hidden" name="course" value={course.id} />
      <input type="hidden" name="version" value={settings.version} />
      <input type="hidden" name="op" value={p.op} />
      {p.question ? <input type="hidden" name="question" value={p.question} /> : null}
      <button
        type="submit"
        className={p.className ?? "secondary"}
        data-testid={p.testid}
        title={p.title}
        aria-label={p.title}
      >
        {p.label}
      </button>
    </form>
  );

  return (
    <>
      <TopBar next={base} />
      <main className="wide">
        <p>
          <Link href={`/studio/courses/${course.id}`}>← {course.title}</Link>
        </p>
        <h1 data-testid="assessment-title">
          Assessment{" "}
          <span className={`badge ${settings.status === "open" ? "published" : ""}`}>
            {settings.status === "open" ? "open" : "closed"}
          </span>
        </h1>
        <p className="muted">
          Learners who are signed in take it from the course page. Each attempt draws its questions from the approved
          ones below, covering every lesson and leaning towards what the learner missed before; the next attempt can
          start {RETAKE_DAYS} days after the last one.
        </p>
        {Number.isInteger(generated) && generated > 0 ? (
          <div className="notice good" role="status" data-testid="generated">
            {generated} new {generated === 1 ? "question" : "questions"} added as drafts. Review them below, then
            approve.
            {one(sp.trimmed)
              ? " Some long lessons were shortened to fit the AI's reading budget, so their later parts may be under-covered."
              : ""}
          </div>
        ) : null}
        <Notices error={one(sp.error)} done={one(sp.done)} />

        <section className="insights-grid" aria-label="Assessment at a glance">
          <div className="card stat">
            <span className="stat-value" data-testid="active-count">
              {active}
            </span>
            <span className="stat-label">approved questions</span>
          </div>
          <div className="card stat">
            <span className="stat-value">{drafts}</span>
            <span className="stat-label">drafts to review</span>
          </div>
          <div className="card stat">
            <span className="stat-value">{assessment.learners}</span>
            <span className="stat-label">
              learners, {assessment.attempts} {assessment.attempts === 1 ? "attempt" : "attempts"}
            </span>
          </div>
          <div className="card stat">
            <span className="stat-value">{assessment.averageScore === null ? "–" : `${assessment.averageScore}%`}</span>
            <span className="stat-label">
              average score{assessment.passRate === null ? "" : `, ${assessment.passRate}% passed`}
            </span>
          </div>
        </section>

        <form action={saveSettingsAction} className="card" id="settings" data-testid="assessment-settings">
          <h2>Settings</h2>
          <input type="hidden" name="course" value={course.id} />
          <input type="hidden" name="version" value={settings.version} />
          <div className="editor-grid">
            <label>
              Learners
              <select name="status" defaultValue={settings.status} data-testid="assessment-status">
                <option value="draft">Closed (only you see it)</option>
                <option value="open">Open to learners</option>
              </select>
            </label>
            <label>
              Questions per attempt
              <input
                type="number"
                name="perAttempt"
                min={ASSESSMENT_LIMITS.minPerAttempt}
                max={ASSESSMENT_LIMITS.maxPerAttempt}
                defaultValue={settings.questionsPerAttempt}
                required
              />
            </label>
            <label>
              Pass mark (%)
              <input type="number" name="passPercent" min={1} max={100} defaultValue={settings.passPercent} required />
            </label>
          </div>
          {course.status !== "published" ? (
            <p className="muted">The course isn&apos;t published yet: learners will see the assessment once it is.</p>
          ) : null}
          <button type="submit" className="secondary" data-testid="save-settings">
            Save settings
          </button>
        </form>

        <GenerateQuestionsForm courseId={course.id} lessons={lessons} aiOn={aiConfigFromEnv() !== null} />

        {creating || editQuestion ? (
          <QuestionEditor
            key={editQuestion?.id ?? "new"}
            courseId={course.id}
            version={settings.version}
            lessons={lessons}
            question={editQuestion}
            defaultLessonId={filterLesson && filterLesson !== "general" ? filterLesson : undefined}
            cancelHref={`${base}#questions`}
          />
        ) : null}

        <section className="card" id="questions" data-testid="question-bank">
          <div className="bank-head">
            <h2>
              Questions{" "}
              <span className="muted">
                ({questions.length} of {ASSESSMENT_LIMITS.bank})
              </span>
            </h2>
            <div className="actions">
              <Link className="button-link" href={`${base}?new=1#editor`} data-testid="new-question">
                + New question
              </Link>
              {drafts > 0 ? (
                <Op op="approve_drafts" label={`Approve all ${drafts} drafts`} testid="approve-drafts" />
              ) : null}
              {drafts > 0 ? (
                <details className="confirm">
                  <summary className="button-like danger">Delete drafts…</summary>
                  <p>Delete all {drafts} draft questions? Approved ones stay.</p>
                  <Op
                    op="delete_drafts"
                    label="Yes, delete the drafts"
                    className="secondary danger"
                    testid="delete-drafts"
                  />
                </details>
              ) : null}
            </div>
          </div>
          <nav className="filter-chips" aria-label="Filter questions">
            <Link href={filterHref({ status: "" })} aria-current={!filterStatus ? "page" : undefined}>
              All
            </Link>
            <Link href={filterHref({ status: "active" })} aria-current={filterStatus === "active" ? "page" : undefined}>
              Approved
            </Link>
            <Link href={filterHref({ status: "draft" })} aria-current={filterStatus === "draft" ? "page" : undefined}>
              Drafts
            </Link>
            <span className="filter-sep" aria-hidden="true" />
            <Link href={filterHref({ lesson: "" })} aria-current={!filterLesson ? "page" : undefined}>
              Every lesson
            </Link>
            {lessons.map((l) => {
              const n = questions.filter((q) => q.lessonId === l.lessonId).length;
              return (
                <Link
                  key={l.lessonId}
                  href={filterHref({ lesson: l.lessonId })}
                  aria-current={filterLesson === l.lessonId ? "page" : undefined}
                  className={n === 0 ? "uncovered" : undefined}
                  title={n === 0 ? "No questions test this lesson yet" : undefined}
                >
                  {l.title} <span className="chip-count">{n}</span>
                </Link>
              );
            })}
          </nav>

          {shown.length === 0 ? (
            <p className="muted">
              {questions.length
                ? "No questions match this filter."
                : "No questions yet. Generate some with AI, or write one."}
            </p>
          ) : (
            <ol className="question-bank">
              {shown.map((q) => {
                const at = questions.indexOf(q);
                const lesson = q.lessonId ? lessonTitle.get(q.lessonId) : null;
                return (
                  <li
                    key={q.id}
                    id={`q-${q.id}`}
                    className={`bank-question ${q.status}`}
                    data-testid="bank-question"
                    data-status={q.status}
                  >
                    <div className="bank-question-head">
                      <span className="badge">{q.kind === "single" ? "Single answer" : "Multiple correct"}</span>
                      <span className={`badge difficulty-${q.difficulty}`}>{DIFFICULTY_LABEL[q.difficulty]}</span>
                      {q.status === "draft" ? <span className="badge draft">Draft</span> : null}
                      {q.source === "ai" ? <span className="badge">AI</span> : null}
                      <span className="muted">
                        {lesson
                          ? `${lesson.moduleTitle} · ${lesson.title}`
                          : q.lessonId
                            ? "A lesson no longer in the draft"
                            : "The course in general"}
                      </span>
                    </div>
                    <p className="bank-prompt">{q.prompt}</p>
                    <QuestionImage image={q.image} />
                    <ul className="bank-options">
                      {q.options.map((o) => (
                        <li key={o.id} className={o.correct ? "correct" : undefined}>
                          <span aria-hidden="true">{o.correct ? "✓" : "○"}</span> {o.text}
                          {o.correct ? <span className="sr-only"> (correct)</span> : null}
                        </li>
                      ))}
                    </ul>
                    {q.explanation ? <p className="muted bank-explanation">{q.explanation}</p> : null}
                    <p className="bank-stats muted" data-testid="question-stats">
                      {q.stats.asked === 0
                        ? "Not asked yet."
                        : `Asked ${q.stats.asked} ${q.stats.asked === 1 ? "time" : "times"}, ${q.stats.correctPercent}% answered it fully right.`}
                      {q.stats.asked >= 5 && (q.stats.correctPercent ?? 0) < 30
                        ? " Few get this right: check it's clear and that the answer is correct."
                        : ""}
                      {q.stats.commonWrongOption ? ` Most chosen wrong answer: “${q.stats.commonWrongOption}”.` : ""}
                    </p>
                    <div className="actions">
                      <Link
                        className="button-link secondary-link"
                        href={`${base}?edit=${q.id}#editor`}
                        data-testid="edit-question"
                      >
                        Edit
                      </Link>
                      {q.status === "draft" ? (
                        <Op op="approve" label="Approve" question={q.id} testid="approve-question" />
                      ) : (
                        <Op op="unapprove" label="Back to draft" question={q.id} />
                      )}
                      {at > 0 ? <Op op="up" label="↑" title="Move up" question={q.id} /> : null}
                      {at < questions.length - 1 ? <Op op="down" label="↓" title="Move down" question={q.id} /> : null}
                      <Op
                        op="delete"
                        label="Delete"
                        question={q.id}
                        className="secondary danger"
                        testid="delete-question"
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </main>
    </>
  );
}
