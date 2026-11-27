import { EngagementBadge } from "@asafarim/engagement/client";
import Link from "next/link";
import { LessonFlag, LessonMarker } from "@/components/CourseProgress";
import type { PublishedCourse } from "@/lib/courses";
import { countsOf, type CourseCounts } from "@/lib/engagement-rollups";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Only what the browser-side progress needs from a course: its modules and lessons in order. */
export const courseShape = (course: PublishedCourse) => ({
  modules: course.modules.map((m) => ({
    title: m.title,
    lessons: m.lessons.map((l) => ({ lessonId: l.lessonId, title: l.title })),
  })),
});

/**
 * A course's modules and lessons: each module a numbered card, each lesson a numbered row linking to it, with the
 * learner's progress (opened, up next, here) on top. `compact` is the lesson page's sidebar: no summaries, the
 * current lesson marked and not a link. Must sit inside a CourseProgressProvider. With `counts`, likes and comments.
 */
export function CourseOutline({
  course,
  current,
  counts,
  compact = false,
}: {
  course: PublishedCourse;
  current?: string;
  counts?: CourseCounts;
  compact?: boolean;
}) {
  let number = 0;
  return (
    <nav
      className={compact ? "course-outline compact" : "course-outline"}
      aria-label="Course outline"
      data-testid="course-outline"
    >
      {course.modules.map((m, mi) => (
        <section key={m.position} className="module-card" data-testid="outline-module">
          <header className="module-head">
            <span className="module-number">Module {mi + 1}</span>
            <h3 className="module-title" data-testid="module-title">
              {m.title}
            </h3>
            <span className="module-meta">
              {plural(m.lessons.length, "lesson", "lessons")}
              {counts && !compact ? (
                <EngagementBadge {...countsOf(counts.modules, m.position)} className="outline-badge" />
              ) : null}
            </span>
          </header>
          <ol className="lesson-list">
            {m.lessons.map((l) => {
              const n = ++number;
              const here = l.lessonId === current;
              const body = (
                <>
                  <LessonMarker lessonId={l.lessonId} number={n} />
                  <span className="lesson-text">
                    <span className="lesson-title" data-testid="outline-lesson-title">
                      {l.title}
                    </span>
                    {!compact && l.summary ? <span className="lesson-summary">{l.summary}</span> : null}
                  </span>
                  <LessonFlag lessonId={l.lessonId} />
                </>
              );
              return (
                <li key={l.lessonId} className="lesson-row" data-testid="outline-lesson">
                  {here ? (
                    <span className="lesson-link" aria-current="page">
                      {body}
                    </span>
                  ) : (
                    <Link className="lesson-link" href={`/courses/${course.slug}/lessons/${l.lessonId}`}>
                      {body}
                    </Link>
                  )}
                  {counts && !compact ? (
                    <EngagementBadge {...countsOf(counts.lessons, l.lessonId)} className="outline-badge" />
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </nav>
  );
}
