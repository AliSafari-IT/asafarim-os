/**
 * One lesson of a published course (#358): the article revision the course pinned, with the course's navigation.
 * The article keeps its own canonical URL (/articles/:slug), which this page names as canonical and links to. A
 * lesson whose article isn't public now, or that isn't in the published course, is a 404.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CourseOutline } from "@/components/CourseOutline";
import { DocView } from "@/components/DocView";
import { Markdown } from "@/components/Markdown";
import { TopBar } from "@/components/TopBar";
import { isUuid } from "@/lib/content";
import { getPublishedLesson } from "@/lib/courses";
import { parseDoc } from "@/lib/doc";
import { feedAlternates } from "@/lib/feed";
import { db } from "@/lib/db";
import { isSlug } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string; lessonId: string }> };

async function load(slug: string, lessonId: string) {
  return isSlug(slug) && isUuid(lessonId) ? getPublishedLesson(await db(), slug, lessonId) : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, lessonId } = await params;
  const lesson = await load(slug, lessonId);
  return lesson
    ? {
        title: `${lesson.title} · ${lesson.course.title}`,
        description: lesson.summary || undefined,
        alternates: { canonical: `/articles/${lesson.articleSlug}`, types: feedAlternates() },
      }
    : {};
}

export default async function LessonPage({ params }: Props) {
  const { slug, lessonId } = await params;
  const lesson = await load(slug, lessonId);
  if (!lesson) notFound();
  const parsed = lesson.doc ? parseDoc(lesson.doc) : null;
  const doc = parsed?.ok ? parsed.doc : null;
  const href = (id: string) => `/courses/${slug}/lessons/${id}`;
  return (
    <>
      <TopBar next={href(lessonId)} />
      <main className="lesson-layout">
        <div>
          <p className="muted" data-testid="lesson-context">
            <Link href={`/courses/${slug}`}>{lesson.course.title}</Link> · {lesson.moduleTitle}
          </p>
          <article data-testid="lesson">
            <h1>{lesson.title}</h1>
            {lesson.summary ? <p className="lead">{lesson.summary}</p> : null}
            {lesson.format === "tiptap" && doc ? <DocView doc={doc} /> : <Markdown markdown={lesson.body} />}
          </article>
          <p className="muted">
            Also published as an article:{" "}
            <Link href={`/articles/${lesson.articleSlug}`} data-testid="canonical">
              /articles/{lesson.articleSlug}
            </Link>
          </p>
          <nav className="lesson-nav" aria-label="Lessons" data-testid="lesson-nav">
            {lesson.prev ? (
              <Link href={href(lesson.prev.lessonId)} rel="prev" data-testid="prev">
                ← {lesson.prev.title}
              </Link>
            ) : (
              <span />
            )}
            {lesson.next ? (
              <Link href={href(lesson.next.lessonId)} rel="next" data-testid="next">
                {lesson.next.title} →
              </Link>
            ) : (
              <Link href={`/courses/${slug}`} data-testid="finish">
                Back to the course
              </Link>
            )}
          </nav>
        </div>
        <aside>
          <CourseOutline course={lesson.course} current={lessonId} />
        </aside>
      </main>
    </>
  );
}
