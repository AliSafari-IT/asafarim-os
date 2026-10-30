"use client";
/**
 * The "Generate a draft" button and what it shows while the AI works (#288): pressed, it is disabled and
 * reads "Generating…", and an indeterminate progress bar replaces the hint, announced as a busy status.
 * The form still posts to its server action without JavaScript; then only the hint shows.
 *
 * The bar is CSS only (app/globals.css, .gen-progress). @asafarim/progress-bars' LinearProgress was the
 * first choice, but 0.7.1 crashes on import with React 19 and its stylesheet pulls ~40 Google Fonts
 * families; switching to it once a release fixes both changes only GenerateProgressView.
 */
import { useFormStatus } from "react-dom";

export function GenerateSubmitView({ pending, disabled }: { pending: boolean; disabled: boolean }) {
  return (
    <div className="actions gen-actions" aria-busy={pending}>
      <button type="submit" disabled={disabled || pending} data-testid="generate-submit">
        {pending ? "Generating…" : "Generate a draft"}
      </button>
      {pending ? (
        <span className="gen-status" role="status" data-testid="generate-pending">
          <span
            className="gen-progress"
            role="progressbar"
            aria-label="Generating the draft"
            aria-valuetext="Reading the issue and drafting the workflow"
          >
            <span className="gen-progress__bar" />
          </span>
          <span className="muted hint">Reading the issue and drafting the workflow; this can take up to a minute.</span>
        </span>
      ) : (
        <span className="muted hint">This can take up to a minute.</span>
      )}
    </div>
  );
}

/** Inside the generate form: pending while its server action runs. */
export function GenerateSubmit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return <GenerateSubmitView pending={pending} disabled={disabled} />;
}
