"use client";

/**
 * A course's study cards, one at a time: tap (or Space / Enter) to flip, Previous / Next (or ← / →, or a swipe) to
 * move, and after flipping, "Still learning" or "I knew it" to mark the card and go on. Marks are kept in this
 * browser (lib/study-cards.ts), so "Review the cards to learn" can go through only the ones not known yet. Shuffle
 * reorders the round. Before the browser's marks are read (and on the server) nothing is marked known.
 *
 * Above the deck, three tiles: the study streak (days in a row with a card flipped, any course), cards mastered
 * (marked "I knew it") and course progress (lessons opened, the same numbers as the course page).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { StudyStats, readStored } from "@/components/StudyStats";
import type { StudyCard } from "@/lib/courses";
import { parseOpened, progressKey } from "@/lib/course-progress";
import {
  STREAK_KEY,
  dayOf,
  deckOrder,
  knownCount,
  knownKey,
  parseDays,
  parseKnown,
  streakOf,
  withDay,
  withKnown,
  type DeckMode,
} from "@/lib/study-cards";

function store(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked (private mode, site data off): it just isn't remembered.
  }
}

const readKnown = (key: string) => readStored(key, parseKnown);

const SWIPE_PX = 48;

export function StudyDeck({
  courseId,
  cards,
  lessonIds,
}: {
  courseId: string;
  cards: StudyCard[];
  /** The course's visible lessons, for the progress tile. */
  lessonIds: string[];
}) {
  const key = knownKey(courseId);
  const ids = useMemo(() => cards.map((c) => c.cardId), [cards]);
  const byId = useMemo(() => new Map(cards.map((c) => [c.cardId, c])), [cards]);
  const [known, setKnown] = useState<string[]>([]);
  const knownSet = useMemo(() => new Set(known), [known]);
  const [mode, setMode] = useState<DeckMode>("all");
  const [shuffle, setShuffle] = useState(false);
  const [order, setOrder] = useState<string[]>(ids);
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [finished, setFinished] = useState(false);
  const cardRef = useRef<HTMLButtonElement>(null);
  const deckRef = useRef<HTMLDivElement>(null);
  /** Set when a control inside the deck had focus just before the change that replaces it. */
  const keepFocus = useRef(false);
  const swipeFrom = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);

  const [days, setDays] = useState<string[]>([]);
  const [today, setToday] = useState("");
  const [opened, setOpened] = useState<string[]>([]);

  useEffect(() => {
    setKnown(readKnown(key));
    setDays(readStored(STREAK_KEY, parseDays));
    setToday(dayOf(new Date()));
    setOpened(readStored(progressKey(courseId), parseOpened));
    // Marks made in another tab show up here too.
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) setKnown(parseKnown(e.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, courseId]);

  // Flipping a card counts as studying today.
  useEffect(() => {
    if (!flipped) return;
    const day = dayOf(new Date());
    const next = withDay(readStored(STREAK_KEY, parseDays), day);
    store(STREAK_KEY, next);
    setDays(next);
    setToday(day);
  }, [flipped]);

  const save = useCallback(
    (next: string[]) => {
      store(key, next);
      setKnown(next);
    },
    [key],
  );

  /** Mark one card, on top of the marks stored now (another tab may have added some), or this tab's when blocked. */
  const markCard = useCallback(
    (cardId: string, isKnown: boolean) => {
      let base = known;
      try {
        base = parseKnown(window.localStorage.getItem(key));
      } catch {
        // Storage blocked: this tab's marks are all there is.
      }
      save(withKnown(base, cardId, isKnown));
    },
    [key, known, save],
  );

  /** Remember whether the keyboard was in the deck, before a click or key replaces the focused control. */
  const noteFocus = () => {
    keepFocus.current = !!deckRef.current?.contains(document.activeElement);
  };

  /** Start a round: the mode's cards, in course order or shuffled, from the first. */
  const startRound = useCallback(
    (nextMode: DeckMode, nextShuffle: boolean, marks: ReadonlySet<string> = knownSet) => {
      setMode(nextMode);
      setShuffle(nextShuffle);
      const nextOrder = deckOrder(ids, { mode: nextMode, known: marks, shuffle: nextShuffle });
      setOrder(nextOrder);
      setPos(0);
      setFlipped(false);
      // A round with no cards (every card known) is over before it starts.
      setFinished(nextOrder.length === 0);
    },
    [ids, knownSet],
  );

  const total = order.length;
  const card = byId.get(order[pos] ?? "");
  const knownNow = knownCount(ids, knownSet);
  const toLearn = ids.length - knownNow;
  const streak = today ? streakOf(days, today) : 0;
  const lessonSet = new Set(lessonIds);
  const openedCount = new Set(opened.filter((id) => lessonSet.has(id))).size;
  const coursePct = lessonIds.length ? Math.round((openedCount / lessonIds.length) * 100) : 0;

  const go = useCallback(
    (delta: -1 | 1) => {
      if (delta > 0 && pos >= total - 1) {
        setFinished(true);
        return;
      }
      setPos((p) => Math.min(Math.max(p + delta, 0), Math.max(total - 1, 0)));
      setFlipped(false);
    },
    [pos, total],
  );

  const mark = (isKnown: boolean) => {
    if (!card) return;
    noteFocus();
    markCard(card.cardId, isKnown);
    go(1);
  };

  // Keep the keyboard in the deck as its controls change ("Show answer" turns into the marking buttons, a mark moves
  // on, a round ends), so ← / → / Space keep working without a click: on the card, or the first end-of-round action.
  useEffect(() => {
    if (!keepFocus.current) return;
    keepFocus.current = false;
    if (finished) deckRef.current?.querySelector<HTMLButtonElement>(".study-done button")?.focus();
    else cardRef.current?.focus();
  }, [pos, finished, flipped]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (finished || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    // A focused button (the card itself included) handles Space and Enter as its own click.
    if (target.tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(-1);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      setFlipped((f) => !f);
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    swipeFrom.current = { x: e.clientX, y: e.clientY };
    swiped.current = false;
  };
  const onPointerUp = (e: PointerEvent) => {
    const from = swipeFrom.current;
    swipeFrom.current = null;
    if (!from) return;
    const dx = e.clientX - from.x;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(e.clientY - from.y)) {
      swiped.current = true;
      go(dx < 0 ? 1 : -1);
    }
  };

  if (ids.length === 0) return null;

  const pct = total ? Math.round(((finished ? total : pos + 1) / total) * 100) : 0;

  return (
    <div
      ref={deckRef}
      className="study-deck"
      data-study-deck=""
      data-testid="study-deck"
      onKeyDown={onKeyDown}
      onPointerDownCapture={noteFocus}
      onKeyDownCapture={noteFocus}
      onClickCapture={noteFocus}
    >
      <StudyStats streak={streak} mastered={knownNow} totalCards={ids.length} coursePct={coursePct} />
      <div className="study-toolbar">
        <div className="study-modes" role="group" aria-label="Which cards">
          <button
            type="button"
            className={mode === "all" ? "study-chip active" : "study-chip"}
            aria-pressed={mode === "all"}
            onClick={() => startRound("all", shuffle)}
            data-testid="mode-all"
          >
            All cards <span className="study-chip-count">{ids.length}</span>
          </button>
          <button
            type="button"
            className={mode === "review" ? "study-chip active" : "study-chip"}
            aria-pressed={mode === "review"}
            onClick={() => startRound("review", shuffle)}
            disabled={toLearn === 0}
            data-testid="mode-review"
          >
            To learn <span className="study-chip-count">{toLearn}</span>
          </button>
        </div>
        <button
          type="button"
          className={shuffle ? "study-chip active" : "study-chip"}
          aria-pressed={shuffle}
          onClick={() => startRound(mode, !shuffle)}
          data-testid="shuffle"
        >
          <span aria-hidden="true">⇄</span> Shuffle
        </button>
      </div>

      <div className="study-progress">
        <div
          className="progress-track"
          role="progressbar"
          aria-label="Cards gone through"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={finished ? total : Math.min(pos + 1, total)}
        >
          <span className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="progress-text" data-testid="study-position" aria-live="polite">
          {finished ? `Round done · ${total} ${total === 1 ? "card" : "cards"}` : `Card ${pos + 1} of ${total}`}
        </span>
        <span className="progress-text study-known" data-testid="study-known">
          {knownNow} of {ids.length} known
        </span>
      </div>

      {finished || !card ? (
        <div className="study-done card" data-testid="study-done">
          <p className="study-done-title">{toLearn === 0 ? "You know every card." : "Round complete."}</p>
          <p className="muted">
            {knownNow} known · {toLearn} still to learn
          </p>
          <div className="actions">
            {toLearn > 0 ? (
              <button type="button" onClick={() => startRound("review", shuffle)} data-testid="review-again">
                Review the {toLearn} to learn
              </button>
            ) : null}
            <button
              type="button"
              className="secondary"
              onClick={() => startRound("all", shuffle)}
              data-testid="restart"
            >
              Go through all cards
            </button>
            {knownNow > 0 ? (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  save([]);
                  startRound("all", shuffle, new Set());
                }}
                data-testid="reset-marks"
              >
                Clear my marks
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <div className="flip-scene">
            <button
              ref={cardRef}
              type="button"
              className={flipped ? "flip-card flipped" : "flip-card"}
              onClick={() => {
                if (swiped.current) {
                  swiped.current = false;
                  return;
                }
                setFlipped((f) => !f);
              }}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerCancel={() => (swipeFrom.current = null)}
              // No aria-label: the button's name is the visible face (the hidden one is aria-hidden), so a screen reader
              // reads the question, or the answer once flipped.
              data-testid="flip-card"
              data-side={flipped ? "back" : "front"}
            >
              <span className="flip-inner">
                <span className="flip-face flip-front" aria-hidden={flipped}>
                  <span className="flip-label">Question</span>
                  <span className="flip-text" data-testid="card-front">
                    {card.front}
                  </span>
                  <span className="flip-hint">Tap to see the answer</span>
                </span>
                <span className="flip-face flip-back" aria-hidden={!flipped}>
                  <span className="flip-label">Answer</span>
                  <span className="flip-text" data-testid="card-back">
                    {card.back}
                  </span>
                  {knownSet.has(card.cardId) ? <span className="flip-hint">Marked as known</span> : null}
                </span>
              </span>
            </button>
          </div>

          <p className="visually-hidden" aria-live="polite" data-testid="card-announce">
            {flipped ? `Answer: ${card.back}` : ""}
          </p>
          <div className="study-controls">
            <button
              type="button"
              className="secondary"
              onClick={() => go(-1)}
              disabled={pos === 0}
              data-testid="card-prev"
            >
              <span aria-hidden="true">←</span> Previous
            </button>
            {flipped ? (
              <div className="study-mark" role="group" aria-label="How did it go?">
                <button type="button" className="secondary" onClick={() => mark(false)} data-testid="mark-learning">
                  Still learning
                </button>
                <button type="button" onClick={() => mark(true)} data-testid="mark-known">
                  I knew it <span aria-hidden="true">✓</span>
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setFlipped(true)} data-testid="card-flip">
                Show answer
              </button>
            )}
            <button type="button" className="secondary" onClick={() => go(1)} data-testid="card-next">
              {pos >= total - 1 ? "Finish" : "Next"} <span aria-hidden="true">→</span>
            </button>
          </div>
          <p className="study-keys muted">
            <kbd>Space</kbd> flip · <kbd>←</kbd> <kbd>→</kbd> move · swipe on a phone
          </p>
        </>
      )}
    </div>
  );
}
