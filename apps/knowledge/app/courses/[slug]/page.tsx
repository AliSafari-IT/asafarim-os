/**
 * One published course and its outline (#358). Only lessons whose article is public now are listed; a course that
 * isn't published (a draft, withdrawn, or no such slug) is a 404, the same for every case.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CourseOutline } from "@/components/CourseOutline";
import { TopBar } from "@/components/TopBar";
import { getPublishedCourse } from "@/lib/courses";
import { db } from "@/lib/db";
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
  const first = course.modules[0]?.lessons[0];
  return (
    <>
      <TopBar next={`/courses/${slug}`} />
      <main>
        <p>
          <Link href="/courses">← Courses</Link>
        </p>
        <h1 data-testid="course-title">{course.title}</h1>
        {course.summary ? <p className="lead">{course.summary}</p> : null}
        {first ? (
          <p>
            <Link className="button-link" href={`/courses/${slug}/lessons/${first.lessonId}`} data-testid="start">
              Start the course
            </Link>
          </p>
        ) : (
          <p className="muted">No lessons are available right now.</p>
        )}
        <CourseOutline course={course} />
      </main>
    </>
  );
}
