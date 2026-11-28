/**
 * A published course's assessment for a learner: what it is, start (or resume) an attempt, the retake lock, past
 * attempts and the insights built from them. Guests are asked to sign in; the page is a 404 when the course isn't
 * public. Everything here is the signed-in learner's own.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { signInAction } from "@/app/actions";
import { startAttemptAction } from "@/app/courses/assessment-actions";
import { AssessmentInsightsView } from "@/components/AssessmentInsights";
import { LocalTime } from "@/components/LocalTime";
import { Notices } from "@/components/Notices";
import { TopBar } from "@/components/TopBar";
import { RETAKE_DAYS } from "@/lib/assessment-core";
import { getLearnerAssessment } from "@/lib/assessments";
import { auth } from "@/lib/auth";
import { getPublishedCourse } from "@/lib/courses";
import { db } from "@/lib/db";
import { one, type SearchParams } from "@/lib/params";
import { isSlug } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const course = isSlug(slug) ? await getPublishedCourse(await db(), slug) : null;
  return course ? { title: `Assessment · ${course.title}`, robots: { index: false } } : {};
}

const when = (d: Date) => <LocalTime iso={d.toISOString()} />;

export default async function CourseAssessmentPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;
  if (!isSlug(slug)) notFound();
  const pool = await db();
  const subject = (await auth())?.user?.id;
  const next = `/courses/${slug}/assessment`;
  if (!subject) {
    const course = await getPublishedCourse(pool, slug);
    if (!course) notFound();
    return (
      <>
        <TopBar next={next} />
        <main className="course-page">
          <p className="back-link">
            <Link href={`/courses/${slug}`}>← {course.title}</Link>
          </p>
          <p className="eyebrow">Assessment</p>
          <h1>{course.title}</h1>
          <div className="card" data-testid="assessment-sign-in">
            <p>
              Sign in to test what you learned. Your results are kept for you, so you can see which lessons need more
              practice.
            </p>
            <form action={signInAction}>
              <input type="hidden" name="next" value={next} />
              <button type="submit">Sign in to start</button>
            </form>
          </div>
        </main>
      </>
    );
  }
  const view = await getLearnerAssessment(pool, subject, slug);
  if (!view) notFound();
  const { course, open, inProgress, lockedUntil, attempts, insights } = view;
  const passPercent = open?.passPercent ?? 70;
  return (
    <>
      <TopBar next={next} />
      <main className="course-page wide">
        <p className="back-link">
          <Link href={`/courses/${slug}`}>← {course.title}</Link>
        </p>
        <header className="study-head">
          <p className="eyebrow">Assessment</p>
          <h1 data-testid="learner-assessment-title">{course.title}</h1>
        </header>
        <Notices error={one(sp.error)} />

        <section className="card assessment-start" data-testid="assessment-start">
          {!open ? (
            <p>This course has no assessment open right now. Your past results stay below.</p>
          ) : inProgress ? (
            <>
              <p>You have an attempt in progress.</p>
              <Link className="button-link" href={`${next}/attempts/${inProgress.id}`} data-testid="resume-attempt">
                Resume it
              </Link>
            </>
          ) : lockedUntil ? (
            <>
              <p data-testid="retake-lock">
                <strong>Next attempt: {when(lockedUntil)}.</strong> You can retake the assessment {RETAKE_DAYS} days
                after your last attempt: time to study the lessons listed under “Study next”.
              </p>
              <Link className="button-link secondary-link" href={`/courses/${slug}/cards`}>
                Practise with the study cards
              </Link>
            </>
          ) : (
            <>
              <ul className="assessment-facts">
                <li>
                  <strong>{open.questionsPerAttempt}</strong> questions from across the course
                </li>
                <li>
                  <strong>{open.minutes}</strong> minutes
                </li>
                <li>
                  pass mark <strong>{open.passPercent}%</strong>
                </li>
                <li>
                  next try after <strong>{RETAKE_DAYS} days</strong>
                </li>
              </ul>
              <p className="muted">
                Some questions have one answer, others several (choose all that apply; partly right earns part of the
                point). {attempts.length ? "This attempt leans towards what you missed before." : ""}
              </p>
              <form action={startAttemptAction}>
                <input type="hidden" name="slug" value={slug} />
                <button type="submit" data-testid="start-attempt">
                  {attempts.length ? "Start a new attempt" : "Start the assessment"}
                </button>
              </form>
            </>
          )}
        </section>

        {attempts.length ? (
          <>
            <section className="insights-grid" aria-label="Your results">
              <div className="card stat">
                <span className="stat-value" data-testid="latest-score">
                  {insights.latest}%
                </span>
                <span className="stat-label">latest score</span>
              </div>
              <div className="card stat">
                <span className="stat-value">{insights.best}%</span>
                <span className="stat-label">best score</span>
              </div>
              <div className="card stat">
                <span className="stat-value">{attempts.length}</span>
                <span className="stat-label">{attempts.length === 1 ? "attempt" : "attempts"}</span>
              </div>
            </section>
            <AssessmentInsightsView insights={insights} slug={slug} passPercent={passPercent} />
            <section className="card" aria-labelledby="attempts-heading">
              <h2 id="attempts-heading">Your attempts</h2>
              <ol className="attempt-list" reversed data-testid="attempt-list">
                {attempts.map((a) => (
                  <li key={a.id}>
                    <Link href={`${next}/attempts/${a.id}`}>{a.submittedAt ? when(a.submittedAt) : "In progress"}</Link>{" "}
                    <strong>{a.score}%</strong>{" "}
                    <span className={a.passed ? "level-tag strong" : "level-tag needs_work"}>
                      {a.passed ? "Passed" : "Not passed"}
                    </span>{" "}
                    <span className="muted">
                      {a.correct} of {a.total} fully right{a.expired ? " · time ran out" : ""}
                    </span>
                  </li>
                ))}
              </ol>
              <p>
                <Link href="/assessments">All my assessment results →</Link>
              </p>
            </section>
          </>
        ) : null}
      </main>
    </>
  );
}
