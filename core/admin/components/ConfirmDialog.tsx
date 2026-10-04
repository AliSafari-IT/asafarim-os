"use client";

import { useId, useRef } from "react";

export interface ConfirmDialogProps {
  /** The visible text of the button that opens the dialog. */
  triggerLabel: string;
  /** What the opening button does, for assistive tech when several look alike ("Deactivate Notes"). */
  triggerAriaLabel?: string;
  title: string;
  description: string;
  confirmLabel: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
  /** The server action the confirmed form submits to. */
  action: (formData: FormData) => void | Promise<void>;
  /** Hidden fields sent with the action. */
  fields: Record<string, string>;
}

/**
 * The styled confirmation (never window.confirm): a native modal <dialog>, so the browser traps focus
 * inside it, Escape cancels, and focus returns to the opening button. It names itself and its
 * description for screen readers. Cancel comes first, so it has focus when the dialog opens: a
 * stray Enter can't confirm a destructive action.
 */
export function ConfirmDialog(p: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  return (
    <>
      <button
        type="button"
        className={`secondary${p.danger ? " danger" : ""}`}
        aria-label={p.triggerAriaLabel}
        aria-haspopup="dialog"
        onClick={() => ref.current?.showModal()}
      >
        {p.triggerLabel}
      </button>
      <dialog ref={ref} className="confirm" aria-labelledby={`${id}-title`} aria-describedby={`${id}-desc`}>
        <form action={p.action} onSubmit={() => ref.current?.close()}>
          {Object.entries(p.fields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <h2 id={`${id}-title`}>{p.title}</h2>
          <p id={`${id}-desc`}>{p.description}</p>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => ref.current?.close()}>
              Cancel
            </button>
            <button type="submit" className={p.danger ? "danger" : undefined}>
              {p.confirmLabel}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
