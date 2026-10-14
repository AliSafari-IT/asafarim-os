"use client";
/**
 * The "Generate GitHub issue" preview (#82). Opening it asks the server for a draft
 * (POST /api/notes/:id/issue/draft: the AI writes it, nothing is created). The owner edits the title,
 * body, labels and target repo, or regenerates; only "Create issue" (POST /api/notes/:id/issue)
 * creates it. A public target repo shows a red banner; a repo the issue token can't reach says
 * "No access to <repo>"; a note that already has an issue needs a confirmation.
 *
 * The banner and the labels describe the repo the draft was made for. A repo typed since has to be
 * regenerated for before it can be created in, so the banner is never out of date.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** What the draft route answers: the preview, or an error to show. */
interface DraftAnswer {
  repo?: string;
  public?: boolean;
  draft?: { title: string; body: string; labels: string[] };
  /** The target repo's existing labels: the only ones that can be picked. */
  labels?: string[];
  issueUrl?: string | null;
  error?: string;
  message?: string;
}

export interface CreateAnswer {
  issue?: { url: string; number: number };
  issueUrl?: string;
  /** On 409 public_not_acknowledged: the repo turned out to be public. */
  public?: boolean;
  error?: string;
  message?: string;
}

/** The repo the current draft was made for. */
export interface Checked {
  repo: string;
  public: boolean;
  labels: string[];
}

export type CreateOutcome =
  | { kind: "created"; url: string }
  /** GitHub has the issue, but its link isn't on the note (500 issue_url_not_saved, 410 note_gone). */
  | { kind: "created_unsaved"; url: string; message: string }
  | { kind: "failed"; error?: string; message: string; issueUrl?: string };

/**
 * The Create request for the repo the draft was made for. `acknowledgedPublic` is true only when the
 * banner was shown for that repo, so the server never takes a public repo on the client's word alone.
 */
export function createRequest(
  current: Checked,
  issue: { title: string; body: string; labels: string[] },
  again: boolean,
) {
  return {
    repo: current.repo,
    title: issue.title,
    body: issue.body,
    labels: issue.labels.filter((l) => current.labels.includes(l)),
    confirm: again,
    acknowledgedPublic: current.public,
  };
}

const UNSAVED_MESSAGE = "The issue was created, but the link could not be saved on this note.";

/** What a Create answer means for the preview. An answer that carries a created issue is never a retryable failure. */
export function createOutcome(status: number, answer: CreateAnswer): CreateOutcome {
  if (status === 201 && answer.issue) return { kind: "created", url: answer.issue.url };
  if (answer.issue && (answer.error === "issue_url_not_saved" || answer.error === "note_gone")) {
    return { kind: "created_unsaved", url: answer.issue.url, message: answer.message ?? UNSAVED_MESSAGE };
  }
  return {
    kind: "failed",
    error: answer.error,
    message: answer.message ?? `The issue couldn't be created (${status}). Try again.`,
    issueUrl: answer.issueUrl,
  };
}

/** The issue exists on GitHub but its link isn't on the note: its link, and nothing that creates it again. */
export function IssueCreatedUnsaved({ url, message }: { url: string; message: string }) {
  return (
    <div className="notice issue-existing" role="alert" data-testid="issue-unsaved">
      <p>{message}</p>
      <p>
        The issue:{" "}
        <a href={url} target="_blank" rel="noopener noreferrer" data-testid="issue-unsaved-link">
          {url.replace(/^https:\/\/github\.com\//, "")}
        </a>
      </p>
    </div>
  );
}

/** A little longer than the server's 60 s AI timeout, so the server's answer comes first. */
const CLIENT_TIMEOUT_MS = 75_000;
export const PUBLIC_BANNER = "This repo is public. Everything below will be visible to everyone.";

const isTimeout = (err: unknown) =>
  typeof err === "object" &&
  err !== null &&
  "name" in err &&
  (err.name === "TimeoutError" || err.name === "AbortError");

async function post<T extends { message?: string }>(
  url: string,
  payload: unknown,
): Promise<{ status: number; answer: T }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    });
    return { status: res.status, answer: ((await res.json().catch(() => null)) as T | null) ?? ({} as T) };
  } catch (err) {
    const message = isTimeout(err) ? "The AI took too long. Try again." : "The app isn't reachable. Try again.";
    return { status: 0, answer: { message } as T };
  }
}

export function IssueDialog({
  noteId,
  issueUrl,
  onClose,
  onCreated,
}: {
  noteId: string;
  /** The issue already made from this note, if any. */
  issueUrl: string | null;
  onClose: () => void;
  onCreated: (url: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<"drafting" | "ready" | "failed">("drafting");
  const [error, setError] = useState("");
  const [noAccess, setNoAccess] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [repo, setRepo] = useState("");
  const [checked, setChecked] = useState<Checked | null>(null);
  const [existing, setExisting] = useState(issueUrl);
  const [second, setSecond] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [unsaved, setUnsaved] = useState<{ url: string; message: string } | null>(null);

  const generate = useCallback(
    async (forRepo?: string) => {
      setPhase("drafting");
      setError("");
      setNoAccess("");
      setCreateError("");
      const { status, answer } = await post<DraftAnswer>(
        `/api/notes/${noteId}/issue/draft`,
        forRepo ? { repo: forRepo } : {},
      );
      if (status === 200 && answer.draft && answer.repo) {
        setTitle(answer.draft.title);
        setBody(answer.draft.body);
        setLabels(answer.draft.labels);
        setRepo(answer.repo);
        setChecked({ repo: answer.repo, public: answer.public === true, labels: answer.labels ?? [] });
        if (answer.issueUrl !== undefined) setExisting(answer.issueUrl);
        setPhase("ready");
        return;
      }
      if (answer.error === "no_repo_access") {
        // Shown by the repo field: pick another repo and regenerate.
        setNoAccess(answer.message ?? "No access to that repository");
        setChecked(null);
      } else {
        setError(answer.message ?? `The issue couldn't be drafted (${status}). Try again.`);
      }
      setPhase("failed");
    },
    [noteId],
  );

  // Once per opening (a development re-run of the effect doesn't ask the AI twice).
  const started = useRef(false);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    if (started.current) return;
    started.current = true;
    void generate();
  }, [generate]);

  const typedRepo = repo.trim();
  // The draft, banner and labels are for `checked.repo`; another repo needs Regenerate first.
  const current = checked && checked.repo === typedRepo ? checked : null;
  const busy = phase === "drafting" || creating;
  // Once an issue exists whose link couldn't be saved, nothing here creates another one.
  const canCreate = phase === "ready" && current !== null && !creating && !unsaved && (!existing || second);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canCreate || !current) return;
    setCreating(true);
    setCreateError("");
    const { status, answer } = await post<CreateAnswer>(
      `/api/notes/${noteId}/issue`,
      createRequest(current, { title, body, labels }, Boolean(existing) && second),
    );
    setCreating(false);
    const outcome = createOutcome(status, answer);
    if (outcome.kind === "created") {
      onCreated(outcome.url);
      return;
    }
    if (outcome.kind === "created_unsaved") {
      setUnsaved({ url: outcome.url, message: outcome.message });
      return;
    }
    // The repo is public after all (made public since the draft): show the banner, then Create again.
    if (outcome.error === "public_not_acknowledged") setChecked({ ...current, public: true });
    if (outcome.error === "issue_exists" && outcome.issueUrl) setExisting(outcome.issueUrl);
    if (outcome.error === "no_repo_access") setNoAccess(outcome.message);
    else setCreateError(outcome.message);
  }

  const toggle = (name: string, on: boolean) =>
    setLabels((now) => (on ? [...now.filter((l) => l !== name), name] : now.filter((l) => l !== name)));

  return (
    <dialog
      ref={dialog}
      className="note-editor issue-dialog"
      aria-labelledby="issue-dialog-title"
      onClose={onClose}
      data-testid="issue-dialog"
    >
      <form onSubmit={create} aria-busy={busy}>
        <h2 id="issue-dialog-title">Generate GitHub issue</h2>
        <p className="muted">Nothing is created until you choose Create issue.</p>

        {current?.public ? (
          <p className="public-banner" role="alert" data-testid="public-banner">
            {PUBLIC_BANNER}
          </p>
        ) : null}

        <p className="visually-hidden" role="status" aria-live="polite">
          {phase === "drafting" ? "Drafting the issue…" : phase === "ready" ? "The draft is ready." : ""}
        </p>
        {phase === "drafting" ? (
          <p className="muted" data-testid="issue-drafting">
            Drafting the issue… (this can take up to a minute)
          </p>
        ) : null}
        {error ? (
          <div className="issue-failed">
            <p className="error" role="alert" data-testid="issue-error">
              {error}
            </p>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void generate(typedRepo || undefined)}
            >
              Try again
            </button>
          </div>
        ) : null}

        <label>
          Target repository <span className="muted">(owner/name)</span>
          <input
            name="repo"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            required
            spellCheck={false}
            autoComplete="off"
            disabled={phase === "drafting"}
          />
        </label>
        {noAccess ? (
          <p className="error" role="alert" data-testid="no-access">
            {noAccess}
          </p>
        ) : null}
        {checked && !current && typedRepo ? (
          <p className="muted small-print" data-testid="repo-changed">
            Choose Regenerate to draft the issue for <span className="mono">{typedRepo}</span>.
          </p>
        ) : null}

        {title ? (
          <>
            <label>
              Title
              <input
                name="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                maxLength={200}
                disabled={phase === "drafting"}
              />
            </label>
            <label>
              Body <span className="muted">(Markdown)</span>
              <textarea
                name="body"
                rows={14}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                required
                maxLength={20000}
                disabled={phase === "drafting"}
              />
            </label>
            {current && current.labels.length ? (
              <fieldset className="issue-labels" disabled={phase === "drafting"}>
                <legend>Labels</legend>
                <div className="issue-label-list">
                  {current.labels.map((l) => (
                    <label key={l} className="check">
                      <input
                        type="checkbox"
                        checked={labels.includes(l)}
                        onChange={(e) => toggle(l, e.target.checked)}
                      />
                      {l}
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : current ? (
              <p className="muted">This repo has no labels.</p>
            ) : null}
          </>
        ) : null}

        {existing ? (
          <div className="notice issue-existing" role="status">
            <p>
              This note already has an issue:{" "}
              <a href={existing} target="_blank" rel="noopener noreferrer">
                {existing.replace(/^https:\/\/github\.com\//, "")}
              </a>
              .
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={second}
                onChange={(e) => setSecond(e.target.checked)}
                data-testid="confirm-second"
              />
              Yes, create a second issue
            </label>
          </div>
        ) : null}

        {unsaved ? <IssueCreatedUnsaved url={unsaved.url} message={unsaved.message} /> : null}

        {createError ? (
          <p className="error" role="alert" data-testid="create-error">
            {createError}
          </p>
        ) : null}

        <div className="actions">
          <button type="button" className="secondary" onClick={() => dialog.current?.close()}>
            {unsaved ? "Close" : "Cancel"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || Boolean(unsaved)}
            onClick={() => void generate(typedRepo || undefined)}
          >
            Regenerate
          </button>
          <button type="submit" disabled={!canCreate} data-testid="create-issue">
            {creating ? "Creating…" : "Create issue"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
