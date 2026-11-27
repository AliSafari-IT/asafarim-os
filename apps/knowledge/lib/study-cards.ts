/**
 * Studying a course's flip cards: which cards this browser marked as known, and the order to go through them. Like
 * lib/course-progress.ts, the marks live in the learner's own browser (localStorage), keyed by the course id, so a
 * private window or cleared site data simply starts afresh. Pure functions here; the React side is
 * components/StudyDeck.tsx.
 */

const MAX_KNOWN = 500;

/** The storage key for one course's "known" marks. */
export const knownKey = (courseId: string) => `knowledge.study-cards.${courseId}`;

/** Parse what was stored; anything unexpected is no marks, never an error. */
export function parseKnown(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? [...new Set(value.filter((v): v is string => typeof v === "string"))].slice(-MAX_KNOWN)
      : [];
  } catch {
    return [];
  }
}

/** Mark a card known (true) or still learning (false). */
export function withKnown(known: readonly string[], cardId: string, isKnown: boolean): string[] {
  const rest = known.filter((id) => id !== cardId);
  return (isKnown ? [...rest, cardId] : rest).slice(-MAX_KNOWN);
}

/** "all": every card; "review": only the cards not marked known. */
export type DeckMode = "all" | "review";

/**
 * The card ids to go through, in course order or shuffled. `random` returns a number in [0, 1) (Math.random in the
 * browser; a fixed sequence in tests).
 */
export function deckOrder(
  cardIds: readonly string[],
  opts: { mode: DeckMode; known: ReadonlySet<string>; shuffle: boolean; random?: () => number },
): string[] {
  const ids = opts.mode === "review" ? cardIds.filter((id) => !opts.known.has(id)) : [...cardIds];
  if (!opts.shuffle) return ids;
  const random = opts.random ?? Math.random;
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  }
  return ids;
}

/** How many of the course's cards are marked known (marks for cards no longer in the course don't count). */
export const knownCount = (cardIds: readonly string[], known: ReadonlySet<string>) =>
  cardIds.reduce((n, id) => (known.has(id) ? n + 1 : n), 0);
