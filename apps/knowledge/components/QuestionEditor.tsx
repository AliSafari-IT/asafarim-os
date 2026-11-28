"use client";
/**
 * Create or edit one assessment question: single answer (radio) or multiple correct (checkboxes), 2 to 6 options,
 * the lesson it tests, difficulty, an explanation learners see after submitting, and an optional picture (an https
 * address, SVG code with a live preview, or an uploaded image). The same checks as the server run as you type; the
 * server checks everything again when saving.
 */
import { useMemo, useState } from "react";
import { saveQuestionAction } from "@/app/studio/assessment-actions";
import { listMediaAction } from "@/app/studio/media-actions";
import {
  ASSESSMENT_LIMITS,
  checkQuestion,
  NO_IMAGE,
  type Difficulty,
  type Question,
  type QuestionKind,
  type QuestionOption,
} from "@/lib/assessment-core";
import { uploadFile } from "@/lib/media-nodes";
import { checkCoverSvg, checkImageUrl, svgDataUrl } from "@/lib/media/validate";
import { ERRORS } from "@/lib/messages";

type ImageSource = "none" | "url" | "svg" | "upload";

export interface LessonChoice {
  lessonId: string;
  title: string;
  moduleTitle: string;
}

let seq = 0;
const newOptionId = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;

const blankOptions = (): QuestionOption[] =>
  [0, 1, 2, 3].map((i) => ({ id: newOptionId(), text: "", correct: i === 0 }));

export function QuestionEditor(props: {
  courseId: string;
  version: number;
  lessons: LessonChoice[];
  question?: Question;
  defaultLessonId?: string;
  cancelHref: string;
}) {
  const q = props.question;
  const image = q?.image ?? NO_IMAGE;
  const [kind, setKind] = useState<QuestionKind>(q?.kind ?? "single");
  const [prompt, setPrompt] = useState(q?.prompt ?? "");
  const [options, setOptions] = useState<QuestionOption[]>(q?.options ?? blankOptions());
  const [explanation, setExplanation] = useState(q?.explanation ?? "");
  const [lessonId, setLessonId] = useState(q?.lessonId ?? props.defaultLessonId ?? "");
  const [difficulty, setDifficulty] = useState<Difficulty>(q?.difficulty ?? "medium");
  const [source, setSource] = useState<ImageSource>(
    image.assetId ? "upload" : image.svg ? "svg" : image.url ? "url" : "none",
  );
  const [url, setUrl] = useState(image.url);
  const [svg, setSvg] = useState(image.svg);
  const [asset, setAsset] = useState(image.assetId ?? "");
  const [alt, setAlt] = useState(image.alt);
  const [library, setLibrary] = useState<{ id: string; filename: string }[] | null>(null);
  const [upload, setUpload] = useState<{ busy: boolean; text?: string; bad?: boolean }>({ busy: false });

  const setKindKeepingAnswers = (k: QuestionKind) => {
    setKind(k);
    // Single answer: keep only the first correct option marked.
    if (k === "single") {
      const first = options.findIndex((o) => o.correct);
      setOptions(options.map((o, i) => ({ ...o, correct: i === (first < 0 ? 0 : first) })));
    }
  };
  const toggleCorrect = (id: string) =>
    setOptions(
      options.map((o) =>
        kind === "single" ? { ...o, correct: o.id === id } : o.id === id ? { ...o, correct: !o.correct } : o,
      ),
    );

  const check = useMemo(
    () =>
      checkQuestion({
        kind,
        prompt,
        options,
        explanation,
        lessonId: lessonId || null,
        difficulty,
        image: { ...NO_IMAGE, alt },
      }),
    [kind, prompt, options, explanation, lessonId, difficulty, alt],
  );
  const svgCheck = useMemo(() => (source === "svg" && svg.trim() ? checkCoverSvg(svg) : null), [source, svg]);
  const urlOk = source === "url" && url.trim() ? checkImageUrl(url) : null;
  const preview =
    source === "svg" && svgCheck?.ok
      ? svgDataUrl(svgCheck.svg)
      : source === "url" && urlOk
        ? urlOk
        : source === "upload" && asset
          ? `/media/${asset}`
          : "";
  const imageProblem =
    source === "svg" && svgCheck && !svgCheck.ok
      ? ERRORS[svgCheck.error]
      : source === "url" && url.trim() && !urlOk
        ? ERRORS.image_url_invalid
        : "";
  // Unfinished options (no text yet) are dropped on save; say so only when they'd leave too few.
  const problem =
    !check.ok && (prompt.trim() || options.some((o) => o.text.trim())) ? ERRORS[`assessment_${check.error}`] : "";

  const onUpload = async (file: File | undefined) => {
    if (!file) return;
    setUpload({ busy: true, text: `Uploading ${file.name}…` });
    const r = await uploadFile(file).catch(() => ({ ok: false as const, error: "media_not_uploaded" }));
    if (r.ok && r.asset.kind === "image") {
      setAsset(r.asset.id);
      setUpload({ busy: false, text: `${r.asset.filename} uploaded.` });
    } else {
      setUpload({
        busy: false,
        bad: true,
        text: r.ok ? "Only images can be shown on a question." : (ERRORS[r.error] ?? r.error),
      });
    }
  };
  const openLibrary = async () => setLibrary(await listMediaAction("image").catch(() => []));

  const marker = kind === "single" ? "radio" : "checkbox";
  const modules = [...new Set(props.lessons.map((l) => l.moduleTitle))];

  return (
    <form action={saveQuestionAction} className="card question-editor" data-testid="question-editor" id="editor">
      <h2>{q ? "Edit question" : "New question"}</h2>
      <input type="hidden" name="course" value={props.courseId} />
      <input type="hidden" name="version" value={props.version} />
      {q ? <input type="hidden" name="question" value={q.id} /> : null}
      <input type="hidden" name="options" value={JSON.stringify(options)} />
      <input type="hidden" name="kind" value={kind} />

      <fieldset className="segmented" aria-label="Question type">
        {(
          [
            ["single", "Single answer", "Learners pick one option (radio buttons)."],
            ["multiple", "Multiple correct", "Learners tick every correct option (checkboxes); partial credit."],
          ] as const
        ).map(([k, label, hint]) => (
          <label key={k} className={kind === k ? "segment active" : "segment"} title={hint}>
            <input type="radio" name="kindChoice" checked={kind === k} onChange={() => setKindKeepingAnswers(k)} />
            {label}
          </label>
        ))}
      </fieldset>

      <label>
        Question
        <textarea
          name="prompt"
          rows={3}
          maxLength={ASSESSMENT_LIMITS.prompt}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          required
          data-testid="question-prompt"
        />
      </label>

      <div className="option-editor" role="group" aria-label="Options">
        <p className="label-like">
          Options{" "}
          <span className="muted">(mark {kind === "single" ? "the one correct answer" : "every correct answer"})</span>
        </p>
        {options.map((o, i) => (
          <div key={o.id} className={o.correct ? "option-row correct" : "option-row"} data-testid="option-row">
            <label className="option-correct" title="Correct answer">
              <input
                type={marker}
                name="correctChoice"
                checked={o.correct}
                onChange={() => toggleCorrect(o.id)}
                aria-label={`Option ${i + 1} is correct`}
              />
            </label>
            <input
              aria-label={`Option ${i + 1}`}
              value={o.text}
              maxLength={ASSESSMENT_LIMITS.option}
              onChange={(e) => setOptions(options.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)))}
              placeholder={`Option ${i + 1}`}
            />
            <button
              type="button"
              className="secondary"
              disabled={options.length <= ASSESSMENT_LIMITS.minOptions}
              onClick={() => setOptions(options.filter((x) => x.id !== o.id))}
              aria-label={`Remove option ${i + 1}`}
              title="Remove option"
            >
              ✕
            </button>
          </div>
        ))}
        {options.length < ASSESSMENT_LIMITS.maxOptions ? (
          <button
            type="button"
            className="secondary"
            onClick={() => setOptions([...options, { id: newOptionId(), text: "", correct: false }])}
            data-testid="add-option"
          >
            + Add option
          </button>
        ) : null}
      </div>

      <div className="editor-grid">
        <label>
          Lesson it tests
          <select
            name="lesson"
            value={lessonId}
            onChange={(e) => setLessonId(e.target.value)}
            data-testid="question-lesson"
          >
            <option value="">The course in general</option>
            {modules.map((m) => (
              <optgroup key={m} label={m}>
                {props.lessons
                  .filter((l) => l.moduleTitle === m)
                  .map((l) => (
                    <option key={l.lessonId} value={l.lessonId}>
                      {l.title}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          Difficulty
          <select name="difficulty" value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty)}>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
        </label>
        <label>
          Status
          <select name="status" defaultValue={q?.status ?? "active"} data-testid="question-status">
            <option value="active">Approved (asked to learners)</option>
            <option value="draft">Draft (not asked yet)</option>
          </select>
        </label>
      </div>

      <label>
        Explanation <span className="muted">(shown after submitting: why the answer is right)</span>
        <textarea
          name="explanation"
          rows={2}
          maxLength={ASSESSMENT_LIMITS.explanation}
          value={explanation}
          onChange={(e) => setExplanation(e.target.value)}
        />
      </label>

      <fieldset className="image-source">
        <legend>Picture</legend>
        <input type="hidden" name="imageSource" value={source} />
        <div className="segmented">
          {(
            [
              ["none", "None"],
              ["upload", "Upload"],
              ["svg", "SVG code"],
              ["url", "Image address"],
            ] as const
          ).map(([s, label]) => (
            <label key={s} className={source === s ? "segment active" : "segment"}>
              <input type="radio" name="imageChoice" checked={source === s} onChange={() => setSource(s)} />
              {label}
            </label>
          ))}
        </div>
        {source === "url" ? (
          <label>
            Image address (https)
            <input name="imageUrl" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          </label>
        ) : null}
        {source === "svg" ? (
          <label>
            SVG code
            <textarea
              name="imageSvg"
              className="mono"
              rows={5}
              value={svg}
              onChange={(e) => setSvg(e.target.value)}
              placeholder='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">…</svg>'
              data-testid="question-svg"
            />
          </label>
        ) : null}
        {source === "upload" ? (
          <div>
            <input type="hidden" name="imageAsset" value={asset} />
            <label>
              Upload an image <span className="muted">(PNG, JPEG, GIF or WebP)</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                disabled={upload.busy}
                onChange={(e) => onUpload(e.target.files?.[0])}
              />
            </label>
            {upload.text ? (
              <p className={upload.bad ? "notice bad" : "muted"} role={upload.bad ? "alert" : "status"}>
                {upload.text}
              </p>
            ) : null}
            {library === null ? (
              <button type="button" className="secondary" onClick={openLibrary}>
                Choose one of my uploaded images
              </button>
            ) : library.length ? (
              <label>
                My images
                <select value={asset} onChange={(e) => setAsset(e.target.value)}>
                  <option value="">Choose…</option>
                  {library.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.filename}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="muted">You haven&apos;t uploaded any images yet.</p>
            )}
          </div>
        ) : null}
        {source !== "none" ? (
          <label>
            Alt text <span className="muted">(what the picture shows, for learners who can&apos;t see it)</span>
            <input
              name="imageAlt"
              value={alt}
              maxLength={ASSESSMENT_LIMITS.imageAlt}
              onChange={(e) => setAlt(e.target.value)}
            />
          </label>
        ) : null}
        {imageProblem ? (
          <p className="notice bad" role="alert">
            {imageProblem}
          </p>
        ) : null}
        {preview ? (
          <figure className="question-image preview">
            <img src={preview} alt={alt} referrerPolicy="no-referrer" />
          </figure>
        ) : null}
      </fieldset>

      {problem ? (
        <p className="notice bad" role="alert" data-testid="question-problem">
          {problem}
        </p>
      ) : null}
      <div className="actions">
        <button type="submit" disabled={!check.ok || Boolean(imageProblem)} data-testid="save-question">
          {q ? "Save question" : "Add question"}
        </button>
        <a className="button-link secondary-link" href={props.cancelHref}>
          Cancel
        </a>
      </div>
    </form>
  );
}
