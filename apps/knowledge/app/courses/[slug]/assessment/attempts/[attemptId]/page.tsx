/**
 * One of the learner's attempts: the runner while it is open, the result once submitted (the score against the pass
 * mark, each module's and lesson's score in this attempt, then every question with the learner's answer, the right
 * one and the explanation). Anyone else's attempt, or a guest, gets a 404 / the sign-in page.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, unauthorized } from "next/navigation";
import { MasteryList } from "@/components/AssessmentInsights";
import { AssessmentRunner } from "@/components/AssessmentRunner";
import { LocalTime } from "@/components/LocalTime";
import { QuestionImage } from "@/components/QuestionImage";
import { TopBar } from "@/components/TopBar";
import { attemptBreakdown } from "@/lib/assessment-core";
import { getAttempt } from "@/lib/assessments";
import { auth } from "@/lib/auth";
import { isUuid } from "@/lib/content";
import { db } from "@/lib/db";
import { one, type SearchParams } from "@/lib/params";
import { isSlug } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Assessment attempt", robots: { index: false } };

type Props = { params: Promise<{ slug: string; attemptId: string }>; searchParams: Promise<SearchParams> };

/** The score as a ring: the share of the circle, with the pass mark as a tick. */
function ScoreRing({ score, passPercent, passed }: { score: number; passPercent: number; passed: boolean }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const tick = (passPercent / 100) * 2 * Math.PI - Math.PI / 2;
  return (
    <svg
      viewBox="0 0 128 128"
      className={passed ? "score-ring passed" : "score-ring"}
      role="img"
      aria-label={`Score ${score}%`}
    >
      <circle cx="64" cy="64" r={r} className="ring-track" />
      <circle
        cx="64"
        cy="64"
        r={r}
        className="ring-fill"
        strokeDasharray={`${(score / 100) * c} ${c}`}
        transform="rotate(-90 64 64)"
      />
      <line
        x1={64 + (r - 9) * Math.cos(tick)}
        y1={64 + (r - 9) * Math.sin(tick)}
        x2={64 + (r + 9) * Math.cos(tick)}
        y2={64 + (r + 9) * Math.sin(tick)}
        className="ring-pass"
      />
      <text x="64" y="70" textAnchor="middle" className="ring-text">
        {score}%
      </text>
    </svg>
  );
}

export default async function AttemptPage({ params, searchParams }: Props) {
  const { slug, attemptId } = await params;
  const sp = await searchParams;
  if (!isSlug(slug) || !isUuid(attemptId)) notFound();
  const subject = (await auth())?.user?.id;
  if (!subject) unauthorized();
  const view = await getAttempt(await db(), subject, attemptId);
  if (!view || view.course.slug !== slug) notFound();
  const back = `/courses/${slug}/assessment`;

  if (view.toAnswer) {
    return (
      <>
        <TopBar next={back} />
        <main className="course-page">
          <p className="back-link">
            <Link href={back}>← {view.course.title}: assessment</Link>
          </p>
          <AssessmentRunner
            slug={slug}
            attemptId={view.id}
            questions={view.toAnswer}
            deadline={view.deadline.toISOString()}
          />
        </main>
      </>
    );
  }

  const res = view.result!;
  const breakdown = attemptBreakdown(res.questions, res.answers);
  const { grade } = res;
  return (
    <>
      <TopBar next={back} />
      <main className="course-page wide">
        <p className="back-link">
          <Link href={back}>← {view.course.title}: assessment and insights</Link>
        </p>
        <header className="result-hero" data-testid="attempt-result">
          <ScoreRing score={grade.score} passPercent={view.passPercent} passed={res.passed} />
          <div>
            <p className="eyebrow">{one(sp.submitted) ? "Submitted" : "Result"}</p>
            <h1 data-testid="result-verdict">{res.passed ? "Passed" : "Not passed yet"}</h1>
            <p className="lead">
              {grade.correct} of {grade.total} fully right, {grade.points} {grade.points === 1 ? "point" : "points"} of{" "}
              {grade.total}. The pass mark is {view.passPercent}%.
            </p>
            {res.expired ? <p className="notice bad">The time ran out before this attempt was submitted.</p> : null}
            <p className="muted">
              Submitted <LocalTime iso={res.submittedAt.toISOString()} />. Next attempt from{" "}
              <LocalTime iso={res.nextAttemptAt.toISOString()} />.
            </p>
          </div>
        </header>

        <div className="insights-two">
          <section className="card">
            <h2>By module</h2>
            <MasteryList
              areas={[...breakdown.modules].sort((a, b) => a.mastery - b.mastery)}
              testid="attempt-modules"
            />
          </section>
          <section className="card">
            <h2>By lesson</h2>
            <MasteryList
              areas={[...breakdown.lessons].sort((a, b) => a.mastery - b.mastery)}
              slug={slug}
              testid="attempt-lessons"
            />
          </section>
        </div>

        <section aria-labelledby="review-heading">
          <h2 id="review-heading">Review your answers</h2>
          <ol className="result-questions">
            {res.questions.map((q, i) => {
              const g = grade.perQuestion[q.id]!;
              const picked = new Set(res.answers[q.id] ?? []);
              const state = g.correct ? "right" : g.points > 0 ? "partial" : "wrong";
              return (
                <li
                  key={q.id}
                  className={`card result-question ${state}`}
                  data-testid="result-question"
                  data-state={state}
                >
                  <p className="eyebrow">
                    Question {i + 1} ·{" "}
                    {state === "right"
                      ? "Right"
                      : state === "partial"
                        ? `Partly right (${Math.round(g.points * 100)}%)`
                        : picked.size
                          ? "Wrong"
                          : "Not answered"}
                    {q.lessonTitle ? ` · ${q.lessonTitle}` : ""}
                  </p>
                  <p className="runner-prompt">{q.prompt}</p>
                  <QuestionImage image={q.image} />
                  <ul className="result-options">
                    {q.options.map((o) => {
                      const cls = [o.correct ? "is-correct" : "", picked.has(o.id) ? "is-picked" : ""].join(" ");
                      return (
                        <li key={o.id} className={cls}>
                          <span aria-hidden="true">{o.correct ? "✓" : picked.has(o.id) ? "✗" : "○"}</span> {o.text}
                          <span className="option-note">
                            {picked.has(o.id) ? " your answer" : ""}
                            {o.correct ? (picked.has(o.id) ? ", correct" : " correct answer") : ""}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  {q.explanation ? <p className="result-explanation">{q.explanation}</p> : null}
                  {!g.correct && q.lessonId ? (
                    <p>
                      <Link href={`/courses/${slug}/lessons/${q.lessonId}`}>Study “{q.lessonTitle}” again →</Link>
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      </main>
    </>
  );
}
