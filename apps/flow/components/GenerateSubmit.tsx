"use client";
/**
 * The "Generate a draft" button and what it shows while the AI works (#288): pressed, it is disabled and
 * reads "Generating…", and an indeterminate progress bar appears in a status region whose text changes.
 * The form still posts to its server action without JavaScript; then only the hint shows.
 *
 * The bar is @asafarim/progress-bars' LinearProgress (0.7.3: React 19, and a stylesheet with no external
 * fonts). Its colours come from design tokens, mapped to Flow's accent in app/globals.css (.gen-progress),
 * and it stops moving under "reduce motion" by itself.
 */
import { LinearProgress } from "@asafarim/progress-bars";
import "@asafarim/progress-bars/dist/style.css";
import { useFormStatus } from "react-dom";

export function GenerateSubmitView({ pending, disabled }: { pending: boolean; disabled: boolean }) {
  // The status region stays mounted and only its content changes, so the change is announced; nothing
  // around it is aria-busy, which would let assistive technologies hold the announcement back.
  return (
    <div className="actions gen-actions">
      <button type="submit" disabled={disabled || pending} data-testid="generate-submit">
        {pending ? "Generating…" : "Generate a draft"}
      </button>
      <div className="gen-status" role="status" data-testid="generate-status">
        {pending ? (
          <div className="gen-progress" data-testid="generate-pending">
            <LinearProgress
              variant="indeterminate"
              size="sm"
              ariaLabel="Generating the draft"
              ariaValueText="Reading the issue and drafting the workflow"
            />
          </div>
        ) : null}
        <span className="muted hint">
          {pending
            ? "Reading the issue and drafting the workflow; this can take up to a minute."
            : "This can take up to a minute."}
        </span>
      </div>
    </div>
  );
}

/** Inside the generate form: pending while its server action runs. */
export function GenerateSubmit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return <GenerateSubmitView pending={pending} disabled={disabled} />;
}
