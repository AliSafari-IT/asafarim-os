"use client";

/**
 * The learner's three tiles: study streak (days in a row with a card flipped, any course), cards mastered (marked
 * "I knew it") and course progress (lessons opened). Everything comes from this browser (lib/study-cards.ts,
 * lib/course-progress.ts); before it is read, and on the server, the tiles show a fresh start.
 */
import { useEffect, useState } from "react";
import { useCourseProgress } from "@/components/CourseProgress";
import { STREAK_KEY, dayOf, knownCount, knownKey, parseDays, parseKnown, streakOf } from "@/lib/study-cards";

export function readStored<T>(key: string, parse: (raw: string | null) => T): T {
  try {
    return parse(window.localStorage.getItem(key));
  } catch {
    return parse(null);
  }
}

function StatTile({ icon, label, value, testid }: { icon: string; label: string; value: string; testid: string }) {
  return (
    <div className="stat-tile" data-testid={testid}>
      <span className="stat-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="stat-text">
        <span className="stat-label">{label}</span>
        <span className="stat-value" data-testid={`${testid}-value`}>
          {value}
        </span>
      </span>
    </div>
  );
}

/** The tiles themselves. The cards tile is left out for a course without cards. */
export function StudyStats({
  streak,
  mastered,
  totalCards,
  coursePct,
}: {
  streak: number;
  mastered: number;
  totalCards: number;
  coursePct: number;
}) {
  return (
    <div className={totalCards ? "study-stats" : "study-stats two"} role="group" aria-label="Your progress">
      <StatTile
        icon="◷"
        label="Study streak"
        value={`${streak} ${streak === 1 ? "day" : "days"}`}
        testid="stat-streak"
      />
      {totalCards ? (
        <StatTile icon="✓" label="Cards mastered" value={`${mastered} of ${totalCards}`} testid="stat-mastered" />
      ) : null}
      <StatTile icon="▧" label="Course progress" value={`${coursePct}%`} testid="stat-course" />
    </div>
  );
}

/** The course page's tiles: inside a CourseProgressProvider, with the published course's card ids. */
export function CourseStats({ courseId, cardIds }: { courseId: string; cardIds: string[] }) {
  const { progress } = useCourseProgress();
  const [streak, setStreak] = useState(0);
  const [mastered, setMastered] = useState(0);
  useEffect(() => {
    setStreak(streakOf(readStored(STREAK_KEY, parseDays), dayOf(new Date())));
    setMastered(knownCount(cardIds, new Set(readStored(knownKey(courseId), parseKnown))));
  }, [courseId, cardIds]);
  const pct = progress.total ? Math.round((progress.done.size / progress.total) * 100) : 0;
  return <StudyStats streak={streak} mastered={mastered} totalCards={cardIds.length} coursePct={pct} />;
}
