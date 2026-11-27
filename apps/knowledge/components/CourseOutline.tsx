import { EngagementBadge } from "@asafarim/engagement/client";
import Link from "next/link";
import type { PublishedCourse } from "@/lib/courses";
import { countsOf, type CourseCounts } from "@/lib/engagement-rollups";

/** A course's modules and lessons, linking each lesson; the current one marked. With `counts`, each module's likes. */
export function CourseOutline({
  course,
  current,
  counts,
}: {
  course: PublishedCourse;
  current?: string;
  counts?: CourseCounts;
}) {
  return (
    <nav className="course-outline" aria-label="Course outline" data-testid="course-outline">
      {course.modules.map((m) => (
        <section key={m.position}>
          <h2>
            {m.title}
            {counts ? (
              <>
                {" "}
                <EngagementBadge {...countsOf(counts.modules, m.position)} className="outline-badge" />
              </>
            ) : null}
          </h2>
          <ol>
            {m.lessons.map((l) => (
              <li key={l.lessonId} data-testid="outline-lesson">
                {l.lessonId === current ? (
                  <strong aria-current="page">{l.title}</strong>
                ) : (
                  <Link href={`/courses/${course.slug}/lessons/${l.lessonId}`}>{l.title}</Link>
                )}
                {counts ? (
                  <>
                    {" "}
                    <EngagementBadge {...countsOf(counts.lessons, l.lessonId)} className="outline-badge" />
                  </>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </nav>
  );
}
