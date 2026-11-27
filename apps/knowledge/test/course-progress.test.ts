import { describe, expect, it } from "vitest";
import { orderLessons, parseOpened, progressOf, statusOf, withOpened } from "../lib/course-progress";

const course = {
  modules: [
    { title: "Design", lessons: [{ lessonId: "a", title: "Plan" }] },
    {
      title: "Delivery",
      lessons: [
        { lessonId: "b", title: "Build" },
        { lessonId: "c", title: "Deploy" },
      ],
    },
  ],
};
const lessons = orderLessons(course);

describe("course progress", () => {
  it("numbers lessons across modules", () => {
    expect(lessons.map((l) => [l.lessonId, l.number, l.module, l.moduleTitle])).toEqual([
      ["a", 1, 1, "Design"],
      ["b", 2, 2, "Delivery"],
      ["c", 3, 2, "Delivery"],
    ]);
  });

  it("starts at the first lesson", () => {
    const p = progressOf(lessons, []);
    expect(p.started).toBe(false);
    expect(p.next?.lessonId).toBe("a");
    expect(statusOf(p, "a")).toBe("next");
    expect(statusOf(p, "b")).toBe("todo");
  });

  it("continues after the most recently opened lesson", () => {
    const p = progressOf(lessons, ["a", "b"]);
    expect(p.started).toBe(true);
    expect(p.done.size).toBe(2);
    expect(p.next?.lessonId).toBe("c");
    expect(statusOf(p, "a")).toBe("done");
    expect(statusOf(p, "b", "b")).toBe("current");
  });

  it("falls back to the first unopened lesson when the one after the last is done", () => {
    expect(progressOf(lessons, ["b", "a"]).next?.lessonId).toBe("c");
    expect(progressOf(lessons, ["c", "b"]).next?.lessonId).toBe("a");
  });

  it("has no next lesson once every lesson is opened, and ignores lessons no longer in the course", () => {
    const p = progressOf(lessons, ["a", "gone", "b", "c"]);
    expect(p.next).toBeNull();
    expect(p.done.size).toBe(3);
    expect(progressOf(lessons, ["gone"]).started).toBe(false);
  });

  it("stores opened lessons most recent last, without duplicates", () => {
    expect(withOpened(["a", "b"], "a")).toEqual(["b", "a"]);
  });

  it("treats anything unexpected in storage as no progress", () => {
    for (const raw of [null, "", "{", "{}", "3", '"a"']) expect(parseOpened(raw)).toEqual([]);
    expect(parseOpened('["a", 2, "b"]')).toEqual(["a", "b"]);
  });
});
