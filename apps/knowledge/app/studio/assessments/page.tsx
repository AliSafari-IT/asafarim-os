/**
 * The Studio's Assessments area: every course this person manages (every course for someone who manages them all),
 * each with its assessment at a glance (open or closed, approved and draft questions, attempts, learners, average
 * score, pass rate), a button to open or close it, and links to generate questions with AI, manage the questions
 * and settings, and see it as a learner. A "New assessment" form starts one for any course that has none yet.
 */
import Link from "next/link";
import { setAssessmentStatusAction, startAssessmentAction } from "../assessment-actions";
import { LocalTime } from "@/components/LocalTime";
import { Notices } from "@/components/Notices";
import { RowMenu, type RowMenuLink } from "@/components/RowMenu";
import { StudioTabs } from "@/components/StudioTabs";
import { TopBar } from "@/components/TopBar";
import { ASSESSMENT_LIMITS } from "@/lib/assessment-core";
import { listStudioAssessments, type StudioAssessmentRow } from "@/lib/assessments";
import { db } from "@/lib/db";
import { one, type SearchParams } from "@/lib/params";
import { canCreateCourse } from "@/lib/policy";
import { requireStudio } from "@/lib/studio";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<SearchParams> };

const STATE: Record<"open" | "draft" | "none", { label: string; className: string; hint: string }> = {
  open: { label: "Open", className: "published", hint: "Signed-in learners can take it now." },
  draft: { label: "Closed", className: "", hint: "Only you see it. Approve at least 3 questions, then open it." },
  none: { label: "Not started", className: "withdrawn-quiet", hint: "No questions yet." },
};

const pct = (v: number | null) => (v === null ? "–" : `${v}%`);

export default async function StudioAssessments({ searchParams }: Props) {
  const g = await requireStudio();
  const sp = await searchParams;
  if (!g.ok) {
    return (
      <>
        <TopBar next="/studio/assessments" />
        <main>
          <Notices error={g.error} />
        </main>
      </>
    );
  }
  const rows = await listStudioAssessments(await db(), g.actor);
  const started = rows.filter((r) => r.status !== null);
  const open = rows.filter((r) => r.status === "open");
  const attempts = rows.reduce((n, r) => n + r.attempts, 0);
  const scored = rows.filter((r) => r.average !== null);
  const average = attempts
    ? Math.round(scored.reduce((n, r) => n + (r.average ?? 0) * r.attempts, 0) / attempts)
    : null;
  const waiting = rows.reduce((n, r) => n + r.drafts, 0);
  const withoutOne = rows.filter((r) => r.status === null);

  return (
    <>
      <TopBar next="/studio/assessments" />
      <main className="studio wide">
        <header className="studio-head">
          <h1>Assessments</h1>
          <p className="muted">
            Build an assessment for each course with AI or by hand, open it to learners, and see how they do.
          </p>
        </header>
        <StudioTabs actor={g.actor} current="assessments" />
        <Notices error={one(sp.error)} done={one(sp.done)} />

        {!canCreateCourse(g.actor) ? (
          <p className="muted">
            Assessments belong to courses, so managing them needs the{" "}
            <span className="perm">knowledge.courses.manage.own</span> permission.
          </p>
        ) : rows.length === 0 ? (
          <div className="studio-empty" data-testid="assessments-empty">
            <p>
              <strong>No courses yet.</strong> An assessment tests a course&apos;s lessons, so start with a course.
            </p>
            <Link className="button-link" href="/studio/courses">
              Create a course
            </Link>
          </div>
        ) : (
          <>
            <section
              className="insights-grid"
              aria-label="All your assessments at a glance"
              data-testid="assessment-totals"
            >
              <div className="card stat">
                <span className="stat-value" data-testid="total-open">
                  {open.length}
                  <span className="stat-of"> / {started.length}</span>
                </span>
                <span className="stat-label">open to learners</span>
              </div>
              <div className="card stat">
                <span className="stat-value">{waiting}</span>
                <span className="stat-label">draft questions to review</span>
              </div>
              <div className="card stat">
                <span className="stat-value" data-testid="total-attempts">
                  {attempts}
                </span>
                <span className="stat-label">attempts submitted</span>
              </div>
              <div className="card stat">
                <span className="stat-value">{pct(average)}</span>
                <span className="stat-label">average score</span>
              </div>
            </section>

            <form action={startAssessmentAction} className="card new-assessment" data-testid="new-assessment">
              <div className="new-assessment-text">
                <h2>
                  New assessment <span className="badge">Claude</span>
                </h2>
                <p className="muted">
                  {withoutOne.length ? (
                    <>
                      Pick a course: Claude reads its lessons and writes {ASSESSMENT_LIMITS.minPerAttempt} to{" "}
                      {ASSESSMENT_LIMITS.maxPerAttempt} questions as drafts for you to review. You can edit them, or add
                      your own, afterwards.
                    </>
                  ) : (
                    <>
                      Every course you manage has an assessment. Use <strong>Generate</strong> on a row to add more
                      questions, or <Link href="/studio/courses">create another course</Link>.
                    </>
                  )}
                </p>
              </div>
              {withoutOne.length ? (
                <div className="new-assessment-pick">
                  <label>
                    <span className="visually-hidden">Course</span>
                    <select name="course" required defaultValue="" data-testid="new-assessment-course">
                      <option value="" disabled>
                        Choose a course…
                      </option>
                      {withoutOne.map((r) => (
                        <option key={r.courseId} value={r.courseId}>
                          {r.title}
                          {r.courseStatus === "published" ? "" : ` (${r.courseStatus})`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" data-testid="new-assessment-start">
                    Generate questions with AI
                  </button>
                </div>
              ) : null}
            </form>

            <h2 id="by-course" className="section-title">
              Your courses
            </h2>
            <div className="table-wrap studio-table">
              <table className="studio-list assessments-table" data-testid="assessment-rows">
                <thead>
                  <tr>
                    <th scope="col">Course</th>
                    <th scope="col">Assessment</th>
                    <th scope="col" className="num">
                      Questions
                    </th>
                    <th scope="col" className="num">
                      Attempts
                    </th>
                    <th scope="col" className="num">
                      Average
                    </th>
                    <th scope="col" className="num">
                      Pass rate
                    </th>
                    <th scope="col">Last attempt</th>
                    <th scope="col" className="studio-actions">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Row key={r.courseId} r={r} highlight={one(sp.course) === r.courseId} />
                  ))}
                </tbody>
              </table>
            </div>

            <ol className="assessment-steps muted" aria-label="How it works">
              <li>
                <strong>Generate</strong> questions from the lessons with AI.
              </li>
              <li>
                <strong>Review</strong> the drafts: edit, delete or add your own.
              </li>
              <li>
                <strong>Approve</strong> the ones you keep, then <strong>open</strong> it.
              </li>
              <li>
                Learners take it from the course page and <strong>Assessments</strong>; a retake unlocks 3 days later.
              </li>
            </ol>
          </>
        )}
      </main>
    </>
  );
}

function Row({ r, highlight }: { r: StudioAssessmentRow; highlight: boolean }) {
  const state = STATE[r.status ?? "none"];
  const manage = `/studio/courses/${r.courseId}/assessment`;
  const canOpen = r.active >= ASSESSMENT_LIMITS.minPerAttempt;
  const links: RowMenuLink[] = [
    { href: `${manage}#questions`, label: "Manage questions" },
    { href: `${manage}#generate`, label: "Generate questions with AI" },
    { href: `${manage}?new=1#editor`, label: "Write a question" },
    { href: `${manage}#settings`, label: "Settings (questions per attempt, pass mark)" },
    ...(r.courseStatus === "published" ? [{ href: `/courses/${r.slug}/assessment`, label: "View as a learner" }] : []),
    { href: `/studio/courses/${r.courseId}`, label: "Edit the course" },
  ];
  return (
    <tr data-testid="assessment-row" data-course={r.slug} className={highlight ? "row-highlight" : undefined}>
      <td className="studio-title">
        <Link href={manage}>{r.title}</Link>
        {r.courseStatus !== "published" ? (
          <span className="muted row-sub">Course {r.courseStatus}: learners can&apos;t see it yet</span>
        ) : null}
      </td>
      <td data-label="Assessment">
        <span className={`badge ${state.className}`} title={state.hint} data-testid="assessment-state">
          {state.label}
        </span>
      </td>
      <td className="num" data-label="Questions">
        <span>
          {r.active}
          {r.drafts ? (
            <Link className="row-sub drafts-link" href={`${manage}?status=draft#questions`}>
              +{r.drafts} to review
            </Link>
          ) : null}
        </span>
      </td>
      <td className="num" data-label="Attempts">
        <span>
          {r.attempts}
          {r.learners ? (
            <span className="muted row-sub">
              {r.learners} {r.learners === 1 ? "learner" : "learners"}
            </span>
          ) : null}
        </span>
      </td>
      <td className="num" data-label="Average">
        {pct(r.average)}
      </td>
      <td className="num" data-label="Pass rate">
        {pct(r.passRate)}
      </td>
      <td className="muted" data-label="Last attempt">
        {r.lastAttemptAt ? <LocalTime iso={r.lastAttemptAt.toISOString()} withTime={false} /> : "–"}
      </td>
      <td className="studio-actions">
        <div className="row-buttons">
          {r.status === null ? (
            <Link className="button-link small" href={`${manage}#generate`} data-testid="assessment-create">
              Generate with AI
            </Link>
          ) : (
            <>
              <Link
                className="button-link secondary-link small"
                href={`${manage}#generate`}
                data-testid="assessment-generate"
              >
                Generate
              </Link>
              <form action={setAssessmentStatusAction} className="inline">
                <input type="hidden" name="course" value={r.courseId} />
                <input type="hidden" name="version" value={r.version} />
                <input type="hidden" name="perAttempt" value={r.questionsPerAttempt} />
                <input type="hidden" name="passPercent" value={r.passPercent} />
                <input type="hidden" name="status" value={r.status === "open" ? "draft" : "open"} />
                <button
                  type="submit"
                  className={r.status === "open" ? "secondary small" : "small"}
                  disabled={r.status !== "open" && !canOpen}
                  title={
                    r.status === "open"
                      ? "Stop new attempts. Past results stay."
                      : canOpen
                        ? "Let signed-in learners take it."
                        : `Approve at least ${ASSESSMENT_LIMITS.minPerAttempt} questions first.`
                  }
                  data-testid="assessment-toggle"
                >
                  {r.status === "open" ? "Close" : "Open"}
                </button>
              </form>
            </>
          )}
          <RowMenu title={r.title} links={links} />
        </div>
      </td>
    </tr>
  );
}
