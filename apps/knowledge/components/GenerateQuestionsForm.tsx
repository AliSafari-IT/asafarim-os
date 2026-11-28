"use client";
/**
 * Ask the AI for 3 to 30 questions from the course's lessons. They are added to the bank as drafts to review; the
 * request can take a minute or two for a long course, so the button says what is happening meanwhile.
 */
import { useState } from "react";
import { useFormStatus } from "react-dom";
import { generateQuestionsAction } from "@/app/studio/assessment-actions";
import { ASSESSMENT_LIMITS } from "@/lib/assessment-core";
import type { LessonChoice } from "./QuestionEditor";

function Submit({ count }: { count: number }) {
  const { pending } = useFormStatus();
  return (
    <>
      <button type="submit" disabled={pending} data-testid="generate-questions">
        {pending ? "Reading the lessons and writing questions…" : `Generate ${count} questions`}
      </button>
      {pending ? (
        <p className="muted" role="status">
          This can take a minute or two for a long course. Keep this tab open.
        </p>
      ) : null}
    </>
  );
}

export function GenerateQuestionsForm(props: { courseId: string; lessons: LessonChoice[]; aiOn: boolean }) {
  const [count, setCount] = useState(10);
  const [all, setAll] = useState(true);
  const modules = [...new Set(props.lessons.map((l) => l.moduleTitle))];
  if (!props.aiOn) {
    return (
      <section className="card" id="generate">
        <h2>Generate with AI</h2>
        <p className="muted">
          AI assistance isn&apos;t set up for this publication, so questions can only be written by hand.
        </p>
      </section>
    );
  }
  return (
    <form action={generateQuestionsAction} className="card generate-form" id="generate" data-testid="generate-form">
      <h2>
        Generate with AI <span className="badge">Claude</span>
      </h2>
      <p className="muted">
        Claude reads the lessons of this course&apos;s draft and writes questions that test understanding, each tied to
        the lesson it covers, with an explanation. They arrive as drafts: review, edit or delete them, then approve.
      </p>
      <input type="hidden" name="course" value={props.courseId} />
      <label>
        How many questions: <strong data-testid="generate-count">{count}</strong>
        <input
          type="range"
          name="count"
          min={ASSESSMENT_LIMITS.minPerAttempt}
          max={ASSESSMENT_LIMITS.maxPerAttempt}
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
        />
      </label>
      <div className="editor-grid">
        <label>
          Question types
          <select name="kinds" defaultValue="mixed">
            <option value="mixed">Mixed</option>
            <option value="single">Single answer only</option>
            <option value="multiple">Multiple correct only</option>
          </select>
        </label>
        <label>
          Difficulty
          <select name="difficulty" defaultValue="mixed">
            <option value="mixed">Mixed (easy to hard)</option>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" name="diagrams" defaultChecked /> Draw a small SVG diagram where it helps a question
      </label>
      <fieldset className="lesson-picker">
        <legend>Lessons</legend>
        <label className="check">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Every lesson
        </label>
        {!all
          ? modules.map((m) => (
              <div key={m} className="lesson-picker-module">
                <p className="muted">{m}</p>
                {props.lessons
                  .filter((l) => l.moduleTitle === m)
                  .map((l) => (
                    <label key={l.lessonId} className="check">
                      <input type="checkbox" name="lessons" value={l.lessonId} defaultChecked /> {l.title}
                    </label>
                  ))}
              </div>
            ))
          : null}
      </fieldset>
      <label>
        Anything to focus on? <span className="muted">(optional)</span>
        <input name="instruction" maxLength={500} placeholder="e.g. focus on error handling and edge cases" />
      </label>
      <Submit count={count} />
    </form>
  );
}
