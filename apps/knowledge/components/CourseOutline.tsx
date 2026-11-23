import Link from "next/link";
import type { PublishedCourse } from "@/lib/courses";

/** A course's modules and lessons, linking each lesson; the current one marked. */
export function CourseOutline({ course, current }: { course: PublishedCourse; current?: string }) {
  return (
    <nav className="course-outline" aria-label="Course outline" data-testid="course-outline">
      {course.modules.map((m, i) => (
        <section key={i}>
          <h2>{m.title}</h2>
          <ol>
            {m.lessons.map((l) => (
              <li key={l.lessonId} data-testid="outline-lesson">
                {l.lessonId === current ? (
                  <strong aria-current="page">{l.title}</strong>
                ) : (
                  <Link href={`/courses/${course.slug}/lessons/${l.lessonId}`}>{l.title}</Link>
                )}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </nav>
  );
}
