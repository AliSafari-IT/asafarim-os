/**
 * One course in the studio (#358): its title, modules and lessons in order, each lesson's pin state, and publish /
 * withdraw. Every form names the revision (and publish / withdraw the publication state) this page shows, so a change
 * made elsewhere meanwhile is refused, not overwritten. Someone who may not manage the course gets a 404.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { editCourseAction, publishCourseAction, withdrawCourseAction } from "../../course-actions";
import { Notices } from "@/components/Notices";
import { TopBar } from "@/components/TopBar";
import { getStudioCourse, listLessonChoices, type StudioLesson } from "@/lib/courses";
import { db } from "@/lib/db";
import { one, type SearchParams } from "@/lib/params";
import { requireStudio } from "@/lib/studio";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> };

const STATE_LABEL: Record<StudioLesson["state"], string> = {
  ok: "current",
  outdated: "newer revision published",
  unavailable: "article not public",
};

export default async function StudioCoursePage({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const g = await requireStudio();
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
  const pool = await db();
  const [course, choices] = await Promise.all([getStudioCourse(pool, g.actor, id), listLessonChoices(pool)]);
  if (!course) notFound();
  // A lesson moves within its module, or across the edge into the neighbouring module, even an empty one.
  const lastModule = course.modules.length - 1;

  /** A small form for one change: the operation, the revision shown, and any extra fields. */
  const Op = ({
    op,
    label,
    fields = {},
    className = "secondary",
    testid,
    title,
  }: {
    op: string;
    label: string;
    /** The accessible name when the label is a symbol. */
    title?: string;
    fields?: Record<string, string | number>;
    className?: string;
    testid?: string;
  }) => (
    <form action={editCourseAction} className="inline">
      <input type="hidden" name="id" value={course.id} />
      <input type="hidden" name="revision" value={course.draftRevisionId} />
      <input type="hidden" name="op" value={op} />
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button type="submit" className={className} data-testid={testid} aria-label={title} title={title}>
        {label}
      </button>
    </form>
  );

  // A published course whose draft differs: guests see the older version until it is published again.
  const pending = course.status === "published" && !course.draftIsPublished;
  const draftLessons = course.modules.reduce((n, m) => n + m.lessons.length, 0);
  const lessons = (n: number) => `${n} ${n === 1 ? "lesson" : "lessons"}`;
  const modules = (n: number) => `${n} ${n === 1 ? "module" : "modules"}`;
  const publishForm = (testid: string) => (
    <form action={publishCourseAction} className="inline">
      <input type="hidden" name="id" value={course.id} />
      <input type="hidden" name="revision" value={course.draftRevisionId} />
      <input type="hidden" name="publication" value={course.publication} />
      <button type="submit" data-testid={testid}>
        {pending ? "Publish changes" : "Publish this version"}
      </button>
    </form>
  );

  return (
    <>
      <TopBar next={`/studio/courses/${course.id}`} />
      <main>
        <p>
          <Link href="/studio/courses">← Courses</Link>
        </p>
        <h1 data-testid="course-title">
          {course.title} <span className={`badge ${course.status}`}>{course.status}</span>
        </h1>
        <Notices error={one(sp.error)} done={one(sp.done)} detail={one(sp.detail)} />

        <section
          className={pending ? "card publication-pending" : "card"}
          data-testid="course-publication"
          id="publication"
        >
          {course.status === "published" ? (
            <p>
              Public at <Link href={`/courses/${course.slug}`}>/courses/{course.slug}</Link>
              {pending ? (
                <>
                  {" "}
                  · <strong data-testid="unpublished-changes">Guests still see the previous version</strong> (
                  {lessons(course.publishedLessons ?? 0)}). This draft has {lessons(draftLessons)} in{" "}
                  {modules(course.modules.length)}: publish it to show your changes.
                </>
              ) : (
                "."
              )}
            </p>
          ) : (
            <p className="muted">Not public. Its address will be /courses/{course.slug}.</p>
          )}
          <div className="actions">
            {!course.draftIsPublished ? publishForm("publish-course") : null}
            {course.status === "published" ? (
              <form action={withdrawCourseAction} className="inline">
                <input type="hidden" name="id" value={course.id} />
                <input type="hidden" name="publication" value={course.publication} />
                <button type="submit" className="secondary danger" data-testid="withdraw-course">
                  Withdraw
                </button>
              </form>
            ) : null}
          </div>
        </section>

        <form action={editCourseAction} className="card">
          <h2>Title and summary</h2>
          <input type="hidden" name="id" value={course.id} />
          <input type="hidden" name="revision" value={course.draftRevisionId} />
          <input type="hidden" name="op" value="meta" />
          <label>
            Title
            <input name="title" defaultValue={course.title} maxLength={200} required />
          </label>
          <label>
            Summary
            <textarea name="summary" rows={2} maxLength={500} defaultValue={course.summary} />
          </label>
          <button type="submit" className="secondary" data-testid="save-meta">
            Save
          </button>
        </form>

        <datalist id="lesson-choices">
          {choices.map((a) => (
            <option key={a.slug} value={a.slug}>
              {a.title}
            </option>
          ))}
        </datalist>

        {course.modules.map((m, mi) => (
          <section key={mi} className="card course-module" data-testid="studio-module">
            <form action={editCourseAction} className="inline-form">
              <input type="hidden" name="id" value={course.id} />
              <input type="hidden" name="revision" value={course.draftRevisionId} />
              <input type="hidden" name="op" value="rename_module" />
              <input type="hidden" name="module" value={mi} />
              <label>
                Module {mi + 1}
                <input name="title" defaultValue={m.title} maxLength={200} required />
              </label>
              <button type="submit" className="secondary">
                Rename
              </button>
            </form>
            {m.lessons.length === 0 ? <p className="muted">No lessons yet.</p> : null}
            <ol className="course-lessons">
              {m.lessons.map((l, li) => {
                const canUp = li > 0 || mi > 0;
                const canDown = li < m.lessons.length - 1 || mi < lastModule;
                return (
                  <li key={l.lessonId} data-testid="studio-lesson" data-state={l.state}>
                    <div>
                      <Link href={`/articles/${l.articleSlug}`}>{l.title}</Link>{" "}
                      <span className={`badge ${l.state === "unavailable" ? "withdrawn" : ""}`}>
                        {STATE_LABEL[l.state]}
                      </span>
                      <span className="muted"> revision {l.pinnedNumber}</span>
                    </div>
                    <div className="actions">
                      {canUp ? <Op op="lesson_up" label="↑" title="Move up" fields={{ lesson: l.lessonId }} /> : null}
                      {canDown ? (
                        <Op op="lesson_down" label="↓" title="Move down" fields={{ lesson: l.lessonId }} />
                      ) : null}
                      {l.state === "outdated" ? (
                        <Op
                          op="update_lesson"
                          label="Update to latest"
                          fields={{ lesson: l.lessonId }}
                          testid="update-lesson"
                        />
                      ) : null}
                      <Op
                        op="remove_lesson"
                        label="Remove"
                        fields={{ lesson: l.lessonId }}
                        className="secondary danger"
                        testid="remove-lesson"
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
            <form action={editCourseAction} className="inline-form" data-testid="add-lesson">
              <input type="hidden" name="id" value={course.id} />
              <input type="hidden" name="revision" value={course.draftRevisionId} />
              <input type="hidden" name="op" value="add_lesson" />
              <input type="hidden" name="module" value={mi} />
              <label>
                Add a lesson <span className="muted">(a published article, by its slug)</span>
                <input name="article" list="lesson-choices" maxLength={96} required />
              </label>
              <button type="submit">Add lesson</button>
            </form>
            {m.lessons.length === 0 ? (
              <Op op="remove_module" label="Remove module" fields={{ module: mi }} className="secondary danger" />
            ) : null}
          </section>
        ))}

        <form action={editCourseAction} className="card inline-form" data-testid="add-module">
          <input type="hidden" name="id" value={course.id} />
          <input type="hidden" name="revision" value={course.draftRevisionId} />
          <input type="hidden" name="op" value="add_module" />
          <label>
            New module
            <input name="title" maxLength={200} required />
          </label>
          <button type="submit" className="secondary">
            Add module
          </button>
        </form>
        {pending ? (
          <div className="publish-bar" role="status" data-testid="publish-bar">
            <span>
              Unpublished changes: guests see {lessons(course.publishedLessons ?? 0)}, the draft has{" "}
              {lessons(draftLessons)}.
            </span>
            {publishForm("publish-bar-button")}
          </div>
        ) : null}
      </main>
    </>
  );
}
