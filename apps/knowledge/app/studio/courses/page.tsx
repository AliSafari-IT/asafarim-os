/**
 * The course studio (#358): the person's courses (every course for someone with knowledge.courses.manage.any) and a
 * form to start one. Behind the same studio gate as the rest of /studio.
 */
import Link from "next/link";
import { createCourseAction } from "../course-actions";
import { Notices } from "@/components/Notices";
import { Pager } from "@/components/Pager";
import { StudioTabs } from "@/components/StudioTabs";
import { TopBar } from "@/components/TopBar";
import { listStudioCourses, type CourseStatus } from "@/lib/courses";
import { db } from "@/lib/db";
import { one, type SearchParams } from "@/lib/params";
import { canCreateCourse } from "@/lib/policy";
import { requireStudio } from "@/lib/studio";

export const dynamic = "force-dynamic";

/** What a status means for a reader, shown when hovering a badge in the list. */
const STATUS_HINT: Record<CourseStatus, string> = {
  draft: "Not public yet: add a lesson, then publish it.",
  published: "Public: guests see it on the Courses page.",
  withdrawn: "Withdrawn: not public. Open it to publish again.",
};

type Props = { searchParams: Promise<SearchParams> };

export default async function StudioCourses({ searchParams }: Props) {
  const g = await requireStudio();
  const sp = await searchParams;
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
  const after = one(sp.after);
  const page = await listStudioCourses(await db(), g.actor, { after });
  const courses = page.items;
  const canCreate = canCreateCourse(g.actor);

  return (
    <>
      <TopBar next="/studio/courses" />
      <main>
        <p>
          <Link href="/studio">← Studio</Link>
        </p>
        <h1>Courses</h1>
        <StudioTabs actor={g.actor} current="courses" />
        <Notices error={one(sp.error)} done={one(sp.done)} />
        {canCreate ? (
          <form action={createCourseAction} className="card" data-testid="new-course">
            <h2>New course</h2>
            <label>
              Title
              <input name="title" maxLength={200} required />
            </label>
            <label>
              Slug <span className="muted">(optional; made from the title when empty)</span>
              <input name="slug" maxLength={96} pattern="[a-z0-9]+(-[a-z0-9]+)*" />
            </label>
            <label>
              Summary
              <textarea name="summary" rows={2} maxLength={500} />
            </label>
            <button type="submit" data-testid="create-course">
              Create course
            </button>
          </form>
        ) : (
          <p className="muted">
            Creating courses needs the <span className="perm">knowledge.courses.manage.own</span> permission.
          </p>
        )}
        {courses.length === 0 && !after ? (
          <p className="muted" data-testid="courses-empty">
            No courses yet.
          </p>
        ) : (
          <>
            {courses.some((c) => c.status !== "published") ? (
              <p className="notice" role="note" data-testid="courses-draft-hint">
                Only <strong>published</strong> courses appear on the public Courses page. To publish a draft, open it,
                add a module and at least one lesson (a published article), then press{" "}
                <strong>Publish this version</strong>.
              </p>
            ) : null}
            <table className="studio-list" data-testid="studio-courses">
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Status</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {courses.map((c) => (
                  <tr key={c.id} data-testid="studio-course">
                    <td>
                      <Link href={`/studio/courses/${c.id}`}>{c.title}</Link>
                    </td>
                    <td>
                      <span className={`badge ${c.status}`} title={STATUS_HINT[c.status]}>
                        {c.status}
                      </span>
                    </td>
                    <td className="muted">{c.updatedAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <Pager after={after} next={page.next} base="/studio/courses" label="Older courses" />
      </main>
    </>
  );
}
