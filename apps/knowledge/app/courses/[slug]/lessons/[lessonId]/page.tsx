/**
 * One lesson of a published course (#358): the article revision the course pinned, with the course's navigation.
 * The article keeps its own canonical URL (/articles/:slug), which this page names as canonical and links to. A
 * lesson whose article isn't public now, or that isn't in the published course, is a 404.
 */
import { ArticleTags } from "@/components/ArticleTags";
import { viewKey } from "@/lib/analytics/classify";
import { recordPageView } from "@/lib/analytics/server";
import { ArticleEngagement } from "@/components/ArticleEngagement";
import { ShareBar } from "@/components/ShareBar";
import { articleUrl } from "@/lib/site";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CourseOutline, courseShape } from "@/components/CourseOutline";
import { CourseProgressProvider, MarkLessonOpened, ProgressMeter } from "@/components/CourseProgress";
import { orderLessons } from "@/lib/course-progress";
import { DocView } from "@/components/DocView";
import { Markdown } from "@/components/Markdown";
import { TopBar } from "@/components/TopBar";
import { isUuid } from "@/lib/content";
import { getPublishedLesson } from "@/lib/courses";
import { parseDoc } from "@/lib/doc";
import { feedAlternates } from "@/lib/feed";
import { db } from "@/lib/db";
import { engagementEnabled } from "@/lib/engagement";
import { countsOf, courseCounts } from "@/lib/engagement-rollups";
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
  await recordPageView(viewKey.lesson(slug));
  const parsed = lesson.doc ? parseDoc(lesson.doc) : null;
  const doc = parsed?.ok ? parsed.doc : null;
  const href = (id: string) => `/courses/${slug}/lessons/${id}`;
  const counts = engagementEnabled() ? await courseCounts(await db(), lesson.course) : undefined;
  const shape = courseShape(lesson.course);
  const ordered = orderLessons(shape);
  const place = ordered.find((l) => l.lessonId === lessonId)!;
  return (
    <>
      <TopBar next={href(lessonId)} />
      <CourseProgressProvider courseId={lesson.course.id} slug={slug} course={shape} current={lessonId}>
        <MarkLessonOpened lessonId={lessonId} />
        <main className="lesson-layout">
          <div>
            <nav className="lesson-context" aria-label="Breadcrumb" data-testid="lesson-context">
              <Link href={`/courses/${slug}`}>{lesson.course.title}</Link>
              <span aria-hidden="true">›</span>
              <span>
                Module {place.module}: {lesson.moduleTitle}
              </span>
            </nav>
            <p className="lesson-step" data-testid="lesson-step">
              Lesson {place.number} of {ordered.length}
            </p>
            <article data-testid="lesson">
              <h1>{lesson.title}</h1>
              {lesson.summary ? <p className="lead">{lesson.summary}</p> : null}
              <ArticleTags tags={lesson.tags} />
              {lesson.format === "tiptap" && doc ? <DocView doc={doc} /> : <Markdown markdown={lesson.body} />}
            </article>
            <nav className="lesson-nav" aria-label="Lessons" data-testid="lesson-nav">
              {lesson.prev ? (
                <Link className="lesson-nav-prev" href={href(lesson.prev.lessonId)} rel="prev" data-testid="prev">
                  <span className="lesson-nav-label">← Previous lesson</span>
                  <span className="lesson-nav-title">{lesson.prev.title}</span>
                </Link>
              ) : (
                <span />
              )}
              {lesson.next ? (
                <Link className="lesson-nav-next" href={href(lesson.next.lessonId)} rel="next" data-testid="next">
                  <span className="lesson-nav-label">Next lesson →</span>
                  <span className="lesson-nav-title">{lesson.next.title}</span>
                </Link>
              ) : (
                <Link className="lesson-nav-next" href={`/courses/${slug}`} data-testid="finish">
                  <span className="lesson-nav-label">That was the last lesson</span>
                  <span className="lesson-nav-title">Back to the course →</span>
                </Link>
              )}
            </nav>
            <ShareBar slug={lesson.articleSlug} title={lesson.title} url={articleUrl(lesson.articleSlug)} />
            <p className="muted">
              Also published as an article:{" "}
              <Link href={`/articles/${lesson.articleSlug}`} data-testid="canonical">
                /articles/{lesson.articleSlug}
              </Link>
            </p>
            {counts ? (
              <ArticleEngagement id={lesson.itemId} next={href(lessonId)} counts={countsOf(counts.lessons, lessonId)} />
            ) : null}
          </div>
          <aside className="lesson-aside" aria-label="This course">
            <p className="aside-title">
              <Link href={`/courses/${slug}`}>{lesson.course.title}</Link>
            </p>
            <ProgressMeter />
            <CourseOutline course={lesson.course} current={lessonId} compact />
          </aside>
        </main>
      </CourseProgressProvider>
    </>
  );
}
