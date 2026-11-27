/**
 * Where a learner is in a course: which lessons this browser has opened and which one comes next. Kept in the
 * learner's own browser (localStorage), not on the server: it only decides what the course page highlights, so a
 * private window or cleared site data simply starts the course afresh. Pure functions here; the React side is
 * components/CourseProgress.tsx.
 */

/** The lessons of a course in reading order, numbered from 1 across modules. */
export interface OrderedLesson {
  lessonId: string;
  title: string;
  /** 1-based, across the whole course. */
  number: number;
  /** 1-based module number. */
  module: number;
  moduleTitle: string;
}

export interface CourseShape {
  modules: { title: string; lessons: { lessonId: string; title: string }[] }[];
}

export function orderLessons(course: CourseShape): OrderedLesson[] {
  let number = 0;
  return course.modules.flatMap((m, mi) =>
    m.lessons.map((l) => ({
      lessonId: l.lessonId,
      title: l.title,
      number: ++number,
      module: mi + 1,
      moduleTitle: m.title,
    })),
  );
}

/** The lessons opened, oldest first (the last one is the most recent). */
export type Opened = readonly string[];

const MAX_OPENED = 200;

/** The storage key for one course. Keyed by the course id, which survives a slug change. */
export const progressKey = (courseId: string) => `knowledge.course-progress.${courseId}`;

/** Parse what was stored; anything unexpected is no progress, never an error. */
export function parseOpened(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(-MAX_OPENED) : [];
  } catch {
    return [];
  }
}

/** Record that a lesson was opened: it moves to the end (most recent), without duplicates. */
export function withOpened(opened: Opened, lessonId: string): string[] {
  return [...opened.filter((id) => id !== lessonId), lessonId].slice(-MAX_OPENED);
}

export interface Progress {
  /** Opened lessons that are still in the course. */
  done: Set<string>;
  /** The lesson to read next: the one after the most recently opened, else the first unopened; null when all are. */
  next: OrderedLesson | null;
  /** True once something was opened, so the call to action says "Continue" rather than "Start". */
  started: boolean;
  total: number;
}

export function progressOf(lessons: readonly OrderedLesson[], opened: Opened): Progress {
  const ids = new Set(lessons.map((l) => l.lessonId));
  const done = new Set(opened.filter((id) => ids.has(id)));
  const last = [...opened].reverse().find((id) => ids.has(id));
  const at = last ? lessons.findIndex((l) => l.lessonId === last) : -1;
  const after = at >= 0 ? lessons[at + 1] : undefined;
  const next = after && !done.has(after.lessonId) ? after : (lessons.find((l) => !done.has(l.lessonId)) ?? null);
  return { done, next, started: done.size > 0, total: lessons.length };
}

export type LessonStatus = "done" | "next" | "current" | "todo";

export function statusOf(progress: Progress, lessonId: string, current?: string): LessonStatus {
  if (lessonId === current) return "current";
  if (progress.done.has(lessonId)) return "done";
  if (progress.next?.lessonId === lessonId) return "next";
  return "todo";
}
