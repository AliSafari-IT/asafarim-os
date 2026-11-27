/**
 * A published course's study cards: flip one at a time, mark what you knew, go again through the rest
 * (components/StudyDeck.tsx). The cards come from the same published course revision as the outline; a course that
 * isn't published, or has no cards, is a 404.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StudyDeck } from "@/components/StudyDeck";
import { TopBar } from "@/components/TopBar";
import { getPublishedCards } from "@/lib/courses";
import { db } from "@/lib/db";
import { isSlug } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

async function load(slug: string) {
  return isSlug(slug) ? getPublishedCards(await db(), slug) : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await load((await params).slug);
  return found?.cards.length
    ? { title: `Study cards · ${found.course.title}`, description: found.course.summary || undefined }
    : {};
}

export default async function CourseCardsPage({ params }: Props) {
  const { slug } = await params;
  const found = await load(slug);
  if (!found || found.cards.length === 0) notFound();
  const { course, cards } = found;
  return (
    <>
      <TopBar next={`/courses/${slug}/cards`} />
      <main className="course-page">
        <p className="back-link">
          <Link href={`/courses/${slug}`}>← {course.title}</Link>
        </p>
        <header className="study-head">
          <p className="eyebrow">Study cards</p>
          <h1 data-testid="study-title">{course.title}</h1>
          <p className="muted">
            {cards.length} {cards.length === 1 ? "card" : "cards"}. Think of the answer, flip the card, then say how it
            went: the cards you knew drop out of “To learn”.
          </p>
        </header>
        <StudyDeck
          courseId={course.id}
          cards={cards}
          lessonIds={course.modules.flatMap((m) => m.lessons.map((l) => l.lessonId))}
        />
      </main>
    </>
  );
}
