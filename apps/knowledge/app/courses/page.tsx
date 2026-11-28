/** Published courses, for anyone (#358). */
import { viewKey } from "@/lib/analytics/classify";
import { recordPageView } from "@/lib/analytics/server";
import type { Metadata } from "next";
import Link from "next/link";
import { Pager } from "@/components/Pager";
import { TopBar } from "@/components/TopBar";
import { auth } from "@/lib/auth";
import { coverSrc, listPublishedCourses } from "@/lib/courses";
import { db } from "@/lib/db";
import { describeAccess } from "@/lib/gate";
import { one, type SearchParams } from "@/lib/params";
import { canCreateCourse } from "@/lib/policy";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Courses" };

type Props = { searchParams: Promise<SearchParams> };

export default async function CoursesPage({ searchParams }: Props) {
  const after = one((await searchParams).after);
  const page = await listPublishedCourses(await db(), { after });
  const courses = page.items;
  await recordPageView(viewKey.courses);
  // Authors get a way in from here; the studio checks the permission again, so this only decides what to show.
  const subject = (await auth())?.user?.id;
  const access = subject ? await describeAccess(subject) : null;
  const canCreate =
    !!subject && access?.state === "active" && canCreateCourse({ subject, permissions: access.permissions });
  return (
    <>
      <TopBar next="/courses" />
      <main>
        <div className="page-head">
          <h1>Courses</h1>
          {canCreate ? (
            <Link href="/studio/courses" className="button-link" data-testid="new-course-link">
              New course
            </Link>
          ) : null}
        </div>
        {courses.length === 0 && !after ? (
          <p className="muted" data-testid="no-courses">
            No courses have been published yet.
          </p>
        ) : (
          <ul className="article-list" data-testid="courses">
            {courses.map((c) => (
              <li
                key={c.slug}
                className={coverSrc(c.cover) ? "card course-card has-cover" : "card"}
                data-testid="course-card"
              >
                {coverSrc(c.cover) ? (
                  <img
                    className="course-card-cover"
                    src={coverSrc(c.cover)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                  />
                ) : null}
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
        <Pager after={after} next={page.next} base="/courses" label="Older courses" />
      </main>
    </>
  );
}
