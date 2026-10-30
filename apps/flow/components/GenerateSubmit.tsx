"use client";
/**
 * The "Generate a draft" button and what it shows while the AI works (#288): pressed, it is disabled and
 * reads "Generating…", and an indeterminate progress bar appears in a status region whose text changes.
 * The form still posts to its server action without JavaScript; then only the hint shows.
 *
 * The bar is CSS only (app/globals.css, .gen-progress). @asafarim/progress-bars' LinearProgress is the
 * intended bar: 0.7.2 works with React 19 (0.7.1 crashed on import), but its dist/style.css still
 * @imports Google Fonts, which every Flow page would then request from Google. Once a release drops
 * those imports, switching changes only GenerateSubmitView.
 */
import { useFormStatus } from "react-dom";

export function GenerateSubmitView({ pending, disabled }: { pending: boolean; disabled: boolean }) {
  // The status region stays mounted and only its content changes, so the change is announced; nothing
  // around it is aria-busy, which would let assistive technologies hold the announcement back.
  return (
    <div className="actions gen-actions">
      <button type="submit" disabled={disabled || pending} data-testid="generate-submit">
        {pending ? "Generating…" : "Generate a draft"}
      </button>
      <span className="gen-status" role="status" data-testid="generate-status">
        {pending ? (
          <span
            className="gen-progress"
            role="progressbar"
            aria-label="Generating the draft"
            aria-valuetext="Reading the issue and drafting the workflow"
            data-testid="generate-pending"
          >
            <span className="gen-progress__bar" />
          </span>
        ) : null}
        <span className="muted hint">
          {pending
            ? "Reading the issue and drafting the workflow; this can take up to a minute."
            : "This can take up to a minute."}
        </span>
      </span>
    </div>
  );
}

/** Inside the generate form: pending while its server action runs. */
export function GenerateSubmit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return <GenerateSubmitView pending={pending} disabled={disabled} />;
}
