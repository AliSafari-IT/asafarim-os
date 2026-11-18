"use client";
/**
 * The draft editor: title, summary and a Markdown body, saved as a new revision on top of the one it
 * opened. The fields are controlled, so a refused save (a conflict, a validation error, an expired
 * session) leaves the author's text exactly as it was. The structured (Tiptap) editor replaces the
 * textarea in a later issue.
 */
import { useActionState, useState } from "react";
import { saveDraftAction, type SaveState } from "@/app/studio/actions";
import { ERRORS } from "@/lib/messages";

export interface EditorFormProps {
  id: string;
  revisionId: string;
  title: string;
  summary: string;
  body: string;
  canEdit: boolean;
}

export function EditorForm(props: EditorFormProps) {
  const [state, action, pending] = useActionState<SaveState, FormData>(saveDraftAction, {});
  const [title, setTitle] = useState(props.title);
  const [summary, setSummary] = useState(props.summary);
  const [body, setBody] = useState(props.body);
  // The draft head the page was rendered with. After a conflict the action refreshes the page, so this
  // becomes the newer revision and the next save builds on it, deliberately: the message says so. The
  // form is keyed by the article, not the revision, so that refresh never resets the author's text.
  const expected = props.revisionId;

  return (
    <form action={action} className="card editor" data-testid="editor">
      {state.error ? (
        <div className="notice bad" role="alert" data-testid="save-error">
          {ERRORS[state.error] ?? state.error}
        </div>
      ) : null}
      <input type="hidden" name="id" value={props.id} />
      <input type="hidden" name="expectedRevisionId" value={expected} />
      <label>
        Title
        <input
          name="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          required
          disabled={!props.canEdit}
        />
      </label>
      <label>
        Summary
        <textarea
          name="summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={2}
          maxLength={500}
          disabled={!props.canEdit}
        />
      </label>
      <label>
        Body (Markdown)
        <textarea
          name="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={18}
          maxLength={200000}
          className="mono"
          disabled={!props.canEdit}
        />
      </label>
      <button type="submit" disabled={pending || !props.canEdit} data-testid="save">
        {pending ? "Saving…" : "Save draft"}
      </button>
    </form>
  );
}
