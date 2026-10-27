"use client";
/**
 * The draft as the approver edits it, with its preview following along (components/Preview.tsx), and
 * the two decisions: Approve (with the edits; a public repository must be acknowledged) and Reject
 * (with an optional comment). Fields the step doesn't list in `editable` are shown, not sent. Plain
 * forms posting to server actions: without JavaScript they still work, the preview then shows the
 * draft as it came.
 */
import { useState } from "react";
import { approveAction, rejectAction } from "@/app/actions";
import { Preview } from "@/components/Preview";
import type { Draft, Editable } from "@/lib/workflow/approval";
import { BODY_MAX, COMMENT_MAX, LABEL_MAX, LABELS_MAX, TITLE_MAX } from "@/lib/workflow/limits";

export function DraftForm({
  approvalId,
  draft,
  editable,
}: {
  approvalId: string;
  draft: Draft;
  editable: readonly Editable[];
}) {
  const [body, setBody] = useState(draft.body);
  const can = (f: Editable) => editable.includes(f);
  return (
    <div className="decide">
      <form action={approveAction} className="card draft" aria-labelledby="draft-heading">
        <h2 id="draft-heading">The issue</h2>
        <input type="hidden" name="approvalId" value={approvalId} />
        <label htmlFor="title">Title</label>
        <input
          id="title"
          name={can("title") ? "title" : undefined}
          defaultValue={draft.title}
          required
          maxLength={TITLE_MAX}
          readOnly={!can("title")}
        />
        <label htmlFor="body">Body (Markdown)</label>
        <textarea
          id="body"
          name={can("body") ? "body" : undefined}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
          maxLength={BODY_MAX}
          rows={14}
          readOnly={!can("body")}
        />
        <label htmlFor="labels">Labels</label>
        <input
          id="labels"
          name={can("labels") ? "labels" : undefined}
          defaultValue={draft.labels.join(", ")}
          aria-describedby="labels-hint"
          readOnly={!can("labels")}
        />
        <p id="labels-hint" className="muted hint">
          Separated by commas; at most {LABELS_MAX}, each up to {LABEL_MAX} characters.
        </p>
        {draft.public ? (
          <p className="check">
            <input type="checkbox" id="acknowledgedPublic" name="acknowledgedPublic" required />
            <label htmlFor="acknowledgedPublic">
              I know <span className="mono">{draft.repo}</span> is public and anyone will see this issue.
            </label>
          </p>
        ) : null}
        <div className="actions">
          <button type="submit" data-testid="approve">
            Approve and create the issue
          </button>
        </div>
      </form>

      <section className="card" aria-labelledby="preview-heading">
        <h2 id="preview-heading">Preview</h2>
        <Preview markdown={body} />
      </section>

      <form action={rejectAction} className="card" aria-labelledby="reject-heading">
        <h2 id="reject-heading">Reject</h2>
        <input type="hidden" name="approvalId" value={approvalId} />
        <label htmlFor="comment">Comment (optional)</label>
        <textarea id="comment" name="comment" maxLength={COMMENT_MAX} rows={3} />
        <div className="actions">
          <button type="submit" className="secondary" data-testid="reject">
            Reject
          </button>
        </div>
      </form>
    </div>
  );
}
