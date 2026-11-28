/**
 * The signed-in learner's assessment results across every course: latest and best score, and when the next attempt
 * may start. Each links to that course's insights.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { LocalTime } from "@/components/LocalTime";
import { TopBar } from "@/components/TopBar";
import { listMyAssessments } from "@/lib/assessments";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "My assessment results", robots: { index: false } };

export default async function MyAssessmentsPage() {
  const subject = (await auth())?.user?.id;
  if (!subject) unauthorized();
  const rows = await listMyAssessments(await db(), subject);
  const now = Date.now();
  return (
    <>
      <TopBar next="/assessments" />
      <main className="wide">
        <p className="eyebrow">Assessments</p>
        <h1>My results</h1>
        {rows.length === 0 ? (
          <p className="muted">
            No results yet. Open a <Link href="/courses">course</Link> and take its assessment.
          </p>
        ) : (
          <ul className="my-assessments" data-testid="my-assessments">
            {rows.map((r) => (
              <li key={r.slug} className="card">
                <h2>
                  <Link href={`/courses/${r.slug}/assessment`}>{r.title}</Link>
                </h2>
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
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
