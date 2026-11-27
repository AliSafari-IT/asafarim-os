/**
 * One published course and its outline (#358). Only lessons whose article is public now are listed; a course that
 * isn't published (a draft, withdrawn, or no such slug) is a 404, the same for every case.
 */
import { viewKey } from "@/lib/analytics/classify";
import { recordPageView } from "@/lib/analytics/server";
import { EngagementBadge } from "@asafarim/engagement/client";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CourseOutline, courseShape } from "@/components/CourseOutline";
import { CourseCallToAction, CourseProgressProvider, ProgressMeter } from "@/components/CourseProgress";
import { TopBar } from "@/components/TopBar";
import { getPublishedCourse } from "@/lib/courses";
import { db } from "@/lib/db";
import { engagementEnabled } from "@/lib/engagement";
import { courseCounts } from "@/lib/engagement-rollups";
import { isSlug } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

async function load(slug: string) {
  return isSlug(slug) ? getPublishedCourse(await db(), slug) : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const course = await load((await params).slug);
  return course ? { title: course.title, description: course.summary || undefined } : {};
}

export default async function CoursePage({ params }: Props) {
  const { slug } = await params;
  const course = await load(slug);
  if (!course) notFound();
  await recordPageView(viewKey.course(slug));
  const lessons = course.modules.reduce((n, m) => n + m.lessons.length, 0);
  const counts = engagementEnabled() ? await courseCounts(await db(), course) : undefined;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    <>
      <TopBar next={`/courses/${slug}`} />
      <main className="course-page">
        <p className="back-link">
          <Link href="/courses">← All courses</Link>
        </p>
        <CourseProgressProvider courseId={course.id} slug={slug} course={courseShape(course)}>
          <header className="course-hero">
            <p className="eyebrow">Course</p>
            <h1 data-testid="course-title">{course.title}</h1>
            {course.summary ? <p className="lead">{course.summary}</p> : null}
            <p className="course-facts" data-testid="course-facts">
              <span>{plural(course.modules.length, "module", "modules")}</span>
              <span aria-hidden="true">·</span>
              <span>{plural(lessons, "lesson", "lessons")}</span>
              {course.cards > 0 ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{plural(course.cards, "study card", "study cards")}</span>
                </>
              ) : null}
              {counts ? (
                <span className="course-engagement" data-testid="course-engagement">
                  <EngagementBadge likes={counts.course.likes} comments={counts.course.comments} />
                </span>
              ) : null}
            </p>
            {lessons > 0 ? (
              <div className="course-cta card">
                <CourseCallToAction />
                <ProgressMeter />
              </div>
            ) : (
              <p className="muted">No lessons are available right now.</p>
            )}
          </header>
          {course.cards > 0 ? (
            <section className="course-study card" aria-labelledby="study-heading" data-testid="course-study">
              <div>
                <h2 id="study-heading">Study cards</h2>
                <p className="muted">
                  {plural(course.cards, "card", "cards")} to test yourself: flip each one, keep the ones you still need
                  to learn.
                </p>
              </div>
              <Link className="button-link" href={`/courses/${slug}/cards`} data-testid="study-link">
                Study the cards <span aria-hidden="true">→</span>
              </Link>
            </section>
          ) : null}
          {lessons > 0 ? (
            <section className="course-contents" aria-labelledby="outline-heading">
              <h2 id="outline-heading">What you will go through</h2>
              <CourseOutline course={course} counts={counts} />
            </section>
          ) : null}
        </CourseProgressProvider>
      </main>
    </>
  );
}
