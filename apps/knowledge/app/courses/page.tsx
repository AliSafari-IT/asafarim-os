/** Published courses, for anyone (#358). */
import type { Metadata } from "next";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { listPublishedCourses } from "@/lib/courses";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Courses" };

export default async function CoursesPage() {
  const courses = await listPublishedCourses(await db());
  return (
    <>
      <TopBar next="/courses" />
      <main>
        <h1>Courses</h1>
        {courses.length === 0 ? (
          <p className="muted" data-testid="no-courses">
            No courses have been published yet.
          </p>
        ) : (
          <ul className="article-list" data-testid="courses">
            {courses.map((c) => (
              <li key={c.slug} className="card" data-testid="course-card">
                <h2>
                  <Link href={`/courses/${c.slug}`}>{c.title}</Link>
                </h2>
                {c.summary ? <p>{c.summary}</p> : null}
                <p className="muted">
                  {c.lessons} {c.lessons === 1 ? "lesson" : "lessons"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
