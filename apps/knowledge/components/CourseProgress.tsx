"use client";

/**
 * The learner's place in a course, read from this browser (lib/course-progress.ts). The outline itself is rendered
 * on the server; these are the small pieces that change with progress: each lesson's marker and "Up next" flag, the
 * progress meter, the call to action, and the effect that records an opened lesson. Before the browser's progress
 * is read (and on the server) everything shows a fresh start, so the first paint is never wrong, only less specific.
 */
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  orderLessons,
  parseOpened,
  progressKey,
  progressOf,
  statusOf,
  withOpened,
  type CourseShape,
  type OrderedLesson,
  type Progress,
} from "@/lib/course-progress";

const CHANGED = "knowledge:course-progress";

interface Value {
  slug: string;
  lessons: OrderedLesson[];
  progress: Progress;
  current?: string;
  markOpened: (lessonId: string) => void;
}

const Ctx = createContext<Value | null>(null);

function read(key: string): string[] {
  try {
    return parseOpened(window.localStorage.getItem(key));
  } catch {
    return [];
  }
}

export function CourseProgressProvider({
  courseId,
  slug,
  course,
  current,
  children,
}: {
  courseId: string;
  slug: string;
  course: CourseShape;
  current?: string;
  children: ReactNode;
}) {
  const key = progressKey(courseId);
  const lessons = useMemo(() => orderLessons(course), [course]);
  const [opened, setOpened] = useState<string[]>([]);

  useEffect(() => {
    const sync = () => setOpened(read(key));
    sync();
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) sync();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGED, sync);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGED, sync);
    };
  }, [key]);

  const markOpened = useCallback(
    (lessonId: string) => {
      const next = withOpened(read(key), lessonId);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage blocked (private mode, site data off): progress just isn't remembered.
      }
      setOpened(next);
      window.dispatchEvent(new Event(CHANGED));
    },
    [key],
  );

  const progress = useMemo(() => progressOf(lessons, opened), [lessons, opened]);
  const value = useMemo(
    () => ({ slug, lessons, progress, current, markOpened }),
    [slug, lessons, progress, current, markOpened],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCourseProgress(): Value {
  const v = useContext(Ctx);
  if (!v) throw new Error("CourseProgressProvider is missing");
  return v;
}

const lessonHref = (slug: string, lessonId: string) => `/courses/${slug}/lessons/${lessonId}`;

/** The numbered circle in front of a lesson: its number, or a check once opened. */
export function LessonMarker({ lessonId, number }: { lessonId: string; number: number }) {
  const { progress, current } = useCourseProgress();
  const status = statusOf(progress, lessonId, current);
  const label = { done: "opened", next: "up next", current: "you are here", todo: "" }[status];
  return (
    <span className="lesson-marker" data-status={status} data-testid="lesson-marker">
      <span aria-hidden="true">{status === "done" ? "✓" : number}</span>
      <span className="visually-hidden">
        Lesson {number}
        {label ? `, ${label}` : ""}
      </span>
    </span>
  );
}

/** The "Up next" pill on the lesson to read next. Nothing on the others. */
export function LessonFlag({ lessonId }: { lessonId: string }) {
  const { progress, current } = useCourseProgress();
  if (statusOf(progress, lessonId, current) !== "next") return null;
  return (
    <span className="lesson-flag" aria-hidden="true" data-testid="up-next">
      Up next
    </span>
  );
}

/** "2 of 5 lessons opened" with a bar. */
export function ProgressMeter() {
  const { progress } = useCourseProgress();
  const { total } = progress;
  const done = progress.done.size;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="progress-meter" data-testid="progress">
      <div
        className="progress-track"
        role="progressbar"
        aria-label="Course progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
      >
        <span className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="progress-text" data-testid="progress-text">
        {done} of {total} {total === 1 ? "lesson" : "lessons"} opened
      </span>
    </div>
  );
}

/** The course page's one obvious next step: start, continue with the next lesson, or review once all are opened. */
export function CourseCallToAction() {
  const { slug, lessons, progress } = useCourseProgress();
  const target = progress.next ?? lessons[0];
  if (!target) return null;
  const verb = !progress.started ? "Start the course" : progress.next ? "Continue" : "Review from the start";
  const lead = !progress.started ? "First up" : progress.next ? "Next" : "You have opened every lesson";
  return (
    <div className="course-cta-action">
      <Link className="button-link button-large" href={lessonHref(slug, target.lessonId)} data-testid="start">
        {verb} <span aria-hidden="true">→</span>
      </Link>
      <p className="course-cta-next" data-testid="cta-next">
        {progress.next || !progress.started ? (
          <>
            {lead}: <strong>Lesson {target.number}</strong> · {target.title}
          </>
        ) : (
          lead
        )}
      </p>
    </div>
  );
}

/** Records the lesson on screen as opened. Renders nothing. */
export function MarkLessonOpened({ lessonId }: { lessonId: string }) {
  const { markOpened } = useCourseProgress();
  useEffect(() => markOpened(lessonId), [lessonId, markOpened]);
  return null;
}

/** "2 of 3 opened" for one module's lessons, on its card in the course page's module grid. */
export function ModuleProgress({ lessonIds }: { lessonIds: string[] }) {
  const { progress } = useCourseProgress();
  const done = lessonIds.filter((id) => progress.done.has(id)).length;
  const pct = lessonIds.length ? Math.round((done / lessonIds.length) * 100) : 0;
  return (
    <span className="module-progress" data-testid="module-progress">
      <span className="module-progress-track" aria-hidden="true">
        <span className="progress-fill" style={{ width: `${pct}%` }} />
      </span>
      <span>{done === lessonIds.length && done > 0 ? "All opened" : `${done} of ${lessonIds.length} opened`}</span>
    </span>
  );
}
