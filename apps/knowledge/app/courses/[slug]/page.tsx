/**
 * One published course (#358): a header (title, summary, the optional cover image, the next step), the learner's
 * tiles (study streak, cards mastered, course progress), the modules as a grid of cards, then the full outline. Only
 * lessons whose article is public now are listed; a course that isn't published (a draft, withdrawn, or no such
 * slug) is a 404, the same for every case.
 */
import { viewKey } from "@/lib/analytics/classify";
import { recordPageView } from "@/lib/analytics/server";
import { EngagementBadge } from "@asafarim/engagement/client";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CourseOutline, ModuleCards, courseShape } from "@/components/CourseOutline";
import { CourseCallToAction, CourseProgressProvider, ProgressMeter } from "@/components/CourseProgress";
import { CourseStats } from "@/components/StudyStats";
import { TopBar } from "@/components/TopBar";
import { getPublishedCards } from "@/lib/courses";
import { db } from "@/lib/db";
import { engagementEnabled } from "@/lib/engagement";
import { courseCounts } from "@/lib/engagement-rollups";
import { isSlug } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

async function load(slug: string) {
  return isSlug(slug) ? getPublishedCards(await db(), slug) : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await load((await params).slug);
  if (!found) return {};
  const { course } = found;
  return {
    title: course.title,
    description: course.summary || undefined,
    openGraph: course.cover.url ? { images: [{ url: course.cover.url, alt: course.cover.alt }] } : undefined,
  };
}

export default async function CoursePage({ params }: Props) {
  const { slug } = await params;
  const found = await load(slug);
  if (!found) notFound();
  const { course, cards } = found;
  await recordPageView(viewKey.course(slug));
  const lessons = course.modules.reduce((n, m) => n + m.lessons.length, 0);
  const counts = engagementEnabled() ? await courseCounts(await db(), course) : undefined;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const cover = course.cover.url;
  return (
    <>
      <TopBar next={`/courses/${slug}`} />
      <main className="course-page wide">
        <p className="back-link">
          <Link href="/courses">← All courses</Link>
        </p>
        <CourseProgressProvider courseId={course.id} slug={slug} course={courseShape(course)}>
          <header className={cover ? "course-hero has-cover" : "course-hero"}>
            <div className="course-hero-text">
              <p className="eyebrow">Course</p>
              <h1 data-testid="course-title">{course.title}</h1>
              {course.summary ? <p className="lead">{course.summary}</p> : null}
              {lessons === 0 ? <p className="muted">No lessons are available right now.</p> : null}
              {lessons > 0 || cards.length > 0 ? (
                <div className="course-hero-actions">
                  {lessons > 0 ? <CourseCallToAction /> : null}
                  {cards.length > 0 ? (
                    <Link
                      className="button-link secondary-link"
                      href={`/courses/${slug}/cards`}
                      data-testid="study-link"
                    >
                      Study the cards <span aria-hidden="true">→</span>
                    </Link>
                  ) : null}
                </div>
              ) : null}
              <p className="course-facts" data-testid="course-facts">
                <span>
                  {plural(lessons, "lesson", "lessons")}
                  {cards.length > 0 ? ` and ${plural(cards.length, "study card", "study cards")}` : ""} across{" "}
                  {plural(course.modules.length, "module", "modules")}
                </span>
                {counts ? (
                  <span className="course-engagement" data-testid="course-engagement">
                    <EngagementBadge likes={counts.course.likes} comments={counts.course.comments} />
                  </span>
                ) : null}
              </p>
            </div>
            {cover ? (
              <figure className="course-cover">
                {/* An author's https image on another site, sent no Referer (like article images without an upload). */}
                <img
                  src={cover}
                  alt={course.cover.alt}
                  decoding="async"
                  referrerPolicy="no-referrer"
                  data-testid="course-cover"
                />
              </figure>
            ) : null}
          </header>

          {lessons > 0 ? (
            <>
              <section className="course-progress-row" aria-label="Your progress">
                <CourseStats courseId={course.id} cardIds={cards.map((k) => k.cardId)} />
                <ProgressMeter />
              </section>

              <section className="course-contents" aria-labelledby="modules-heading">
                <p className="eyebrow">The road ahead</p>
                <h2 id="modules-heading">Course modules</h2>
                <ModuleCards course={course} />
              </section>

              <section className="course-contents" aria-labelledby="outline-heading">
                <h2 id="outline-heading">What you will go through</h2>
                <CourseOutline course={course} counts={counts} />
              </section>
            </>
          ) : null}
        </CourseProgressProvider>
      </main>
    </>
  );
}
