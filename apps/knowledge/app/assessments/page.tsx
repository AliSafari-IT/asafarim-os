/**
 * Assessments, from the main menu. Everyone sees the assessments open now (one per published course). A signed-in
 * learner also sees, on each, where they stand (not taken yet, their latest score, when the next attempt may start),
 * and their results in every course they were assessed in, each linking to that course's insights. Someone who
 * builds courses gets a way into the Studio's Assessments area. Taking one needs only a sign-in.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { signInAction } from "@/app/actions";
import { LocalTime } from "@/components/LocalTime";
import { TopBar } from "@/components/TopBar";
import { attemptMinutes, RETAKE_DAYS } from "@/lib/assessment-core";
import { listAvailableAssessments, listMyAssessments, type MyAssessment } from "@/lib/assessments";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { describeAccess } from "@/lib/gate";
import { PERMISSIONS } from "@/lib/policy";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Assessments", robots: { index: false } };

export default async function AssessmentsPage() {
  const subject = (await auth())?.user?.id;
  const pool = await db();
  const [available, mine, access] = await Promise.all([
    listAvailableAssessments(pool),
    subject ? listMyAssessments(pool, subject) : Promise.resolve([] as MyAssessment[]),
    subject ? describeAccess(subject) : Promise.resolve(null),
  ]);
  const builds =
    access?.state === "active" &&
    (access.permissions.includes(PERMISSIONS.coursesOwn) || access.permissions.includes(PERMISSIONS.coursesAny));
  const mineBySlug = new Map(mine.map((m) => [m.slug, m]));
  const now = Date.now();
  const best = mine.length ? Math.max(...mine.map((m) => m.best)) : null;
  const totalAttempts = mine.reduce((n, m) => n + m.attempts, 0);

  return (
    <>
      <TopBar next="/assessments" />
      <main className="wide assessments-home">
        <header className="studio-head">
          <p className="eyebrow">Assessments</p>
          <h1>Test what you&apos;ve learned</h1>
          <p className="muted">
            Each course can have an assessment drawn from its lessons. Your results show which topics to study next; you
            can retake an assessment {RETAKE_DAYS} days after each attempt.
          </p>
        </header>

        {builds ? (
          <div className="card builder-card" data-testid="builder-card">
            <div>
              <h2>You build courses</h2>
              <p className="muted">
                Generate assessments for your courses with AI, review the questions, open them to learners and follow
                their scores.
              </p>
            </div>
            <Link className="button-link" href="/studio/assessments" data-testid="manage-assessments">
              Manage assessments
            </Link>
          </div>
        ) : null}

        {subject && mine.length ? (
          <section aria-labelledby="my-results" data-testid="my-results">
            <h2 id="my-results" className="section-title">
              My results
            </h2>
            <div className="insights-grid">
              <div className="card stat">
                <span className="stat-value">{mine.length}</span>
                <span className="stat-label">{mine.length === 1 ? "course assessed" : "courses assessed"}</span>
              </div>
              <div className="card stat">
                <span className="stat-value">{totalAttempts}</span>
                <span className="stat-label">{totalAttempts === 1 ? "attempt" : "attempts"}</span>
              </div>
              <div className="card stat">
                <span className="stat-value">{best}%</span>
                <span className="stat-label">best score</span>
              </div>
            </div>
            <ul className="my-assessments" data-testid="my-assessments">
              {mine.map((r) => (
                <li key={r.slug} className="card assessment-card">
                  <h3>
                    <Link href={`/courses/${r.slug}/assessment`}>{r.title}</Link>
                  </h3>
                  <p>
                    Latest <strong>{r.latest}%</strong> · best <strong>{r.best}%</strong> · {r.attempts}{" "}
                    {r.attempts === 1 ? "attempt" : "attempts"}
                  </p>
                  <p className="muted">
                    {r.nextAttemptAt.getTime() > now ? (
                      <>
                        Next attempt from <LocalTime iso={r.nextAttemptAt.toISOString()} />
                      </>
                    ) : (
                      "You can take it again now."
                    )}
                  </p>
                  <Link className="button-link secondary-link" href={`/courses/${r.slug}/assessment#insights-heading`}>
                    See my insights
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby="available" data-testid="available-assessments">
          <h2 id="available" className="section-title">
            {subject && mine.length ? "All assessments" : "Available assessments"}
          </h2>
          {available.length === 0 ? (
            <p className="studio-empty muted" data-testid="no-assessments">
              No course has an open assessment yet. Browse the <Link href="/courses">courses</Link> in the meantime.
            </p>
          ) : (
            <ul className="assessment-grid">
              {available.map((a) => {
                const m = mineBySlug.get(a.slug);
                const waiting = m && m.nextAttemptAt.getTime() > now;
                return (
                  <li key={a.slug} className="card assessment-card" data-testid="available-assessment">
                    <h3>{a.title}</h3>
                    <p className="muted">
                      {a.questions} questions · about {attemptMinutes(a.questions)} minutes
                    </p>
                    <p className="assessment-state">
                      {!subject ? (
                        "Sign in to take it."
                      ) : !m ? (
                        "Not taken yet."
                      ) : waiting ? (
                        <>
                          Latest {m.latest}%. Next attempt from <LocalTime iso={m.nextAttemptAt.toISOString()} />
                        </>
                      ) : (
                        <>Latest {m.latest}%. You can take it again.</>
                      )}
                    </p>
                    <div className="row-buttons">
                      {subject ? (
                        <Link className="button-link" href={`/courses/${a.slug}/assessment`}>
                          {!m ? "Start" : waiting ? "See results" : "Take again"}
                        </Link>
                      ) : (
                        <form action={signInAction}>
                          <input type="hidden" name="next" value={`/courses/${a.slug}/assessment`} />
                          <button type="submit">Sign in to start</button>
                        </form>
                      )}
                      <Link href={`/courses/${a.slug}`}>The course</Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
