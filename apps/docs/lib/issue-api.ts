import "server-only";
/**
 * What the two note-to-issue routes share (#82): the gate (docs.read, then docs.issues.create), the
 * caller's own note, the configured services, the document and the repo that owns it, and the
 * answers for each failure. Logs carry ids, counts and token usage only: never the prompt, the note
 * or the generated text.
 */
import manifest from "../platform.app";
import { gate } from "./gate";
import {
  AiTimeoutError,
  AiUnavailableError,
  getIssueTracker,
  getIssueWriter,
  GitHubUnavailableError,
  NoRepoAccessError,
  type IssueTracker,
  type IssueWriter,
} from "./issue-clients";
import { json, notFound } from "./notes-api";
import { getNotes, noteId, type Note, type NotesStore } from "./notes";
import { ownerOf } from "./owners";
import { getPlatform } from "./platform";
import { DocNotFoundError, getSource, SourceUnavailableError } from "./source";

/** The reader's own domain: links to it are useless in an issue (nobody else can open them). */
export const APP_DOMAIN = manifest.domains?.primary ?? "docs.asafarim.site";

const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  json({ error, message, ...extra }, status);

export const invalidIssue = (message: string) => fail(422, "invalid_issue", message);

/** The caller and the note (their own), or the answer to send. */
export async function issueAccess(
  rawId: string,
): Promise<{ ok: true; subject: string; store: NotesStore; note: Note } | { ok: false; res: Response }> {
  const read = await gate("docs.read");
  if (!read.ok) return { ok: false, res: json(read.body, read.status) };
  const issues = await gate("docs.issues.create");
  if (!issues.ok) return { ok: false, res: json(issues.body, issues.status) };
  const store = getNotes();
  if (!store) return { ok: false, res: fail(503, "notes_unavailable", "Notes aren't available (no database).") };
  const id = noteId(rawId);
  const note = id ? await store.get(read.subject, id) : null;
  if (!note) return { ok: false, res: notFound() };
  return { ok: true, subject: read.subject, store, note };
}

/** Both secrets are set, so the buttons work; without them they show, disabled, as "not set up yet". */
export const issuesConfigured = () => Boolean(process.env.DOCS_AI_API_KEY && process.env.DOCS_ISSUES_TOKEN);

const notConfigured = () => fail(503, "issues_unavailable", "Creating GitHub issues isn't set up on this server yet.");

/** GitHub, for both routes. */
export function issueTracker(): { ok: true; tracker: IssueTracker } | { ok: false; res: Response } {
  const tracker = getIssueTracker();
  return tracker ? { ok: true, tracker } : { ok: false, res: notConfigured() };
}

/** The AI, for a draft; its model is the app's `ai.model` config. */
export function issueWriter(): { ok: true; writer: IssueWriter } | { ok: false; res: Response } {
  const writer = getIssueWriter(getPlatform().config.getString("ai.model"));
  return writer ? { ok: true, writer } : { ok: false, res: notConfigured() };
}

/** The note's document and the repo that owns it (front matter, docs-app.json, else the source repo). */
export async function noteDocument(
  docPath: string,
): Promise<{ ok: true; markdown: string; ownerRepo: string } | { ok: false; res: Response }> {
  const config = getPlatform().config;
  const sourceRepo = config.getString("source.repo");
  const source = getSource({ repo: sourceRepo, branch: config.getString("source.branch") });
  try {
    const [listing, markdown] = await Promise.all([source.listDocs(), source.readDoc(docPath)]);
    const owners = listing.owners?.ok ? listing.owners.config : undefined;
    return {
      ok: true,
      markdown,
      ownerRepo: ownerOf(docPath, { config: owners, markdown, fallbackRepo: sourceRepo }).repo,
    };
  } catch (err) {
    if (err instanceof DocNotFoundError) {
      return { ok: false, res: fail(422, "doc_gone", "The note's document isn't in the source any more.") };
    }
    if (err instanceof SourceUnavailableError) {
      return { ok: false, res: fail(503, "source_unavailable", "Documents temporarily unavailable") };
    }
    throw err;
  }
}

/** The answer for a failed outside call, or the error again when it isn't one of theirs. */
export function serviceFailure(err: unknown): Response {
  if (err instanceof NoRepoAccessError) {
    return fail(422, "no_repo_access", `No access to ${err.repo}`, { repo: err.repo });
  }
  if (err instanceof GitHubUnavailableError)
    return fail(502, "github_unavailable", "GitHub isn't answering. Try again.");
  if (err instanceof AiTimeoutError) return fail(504, "ai_timeout", "The AI took too long. Try again.");
  if (err instanceof AiUnavailableError) return fail(502, "ai_unavailable", "The AI isn't answering. Try again.");
  throw err;
}

/**
 * Saves a created issue's URL on its note. The issue already exists on GitHub, so a failure here is
 * never a plain error: the answer carries the issue (`{ error, message, issue }`), so the preview shows
 * its link instead of offering a retry that would create a second one.
 *   500 `issue_url_not_saved`: the database refused the update.
 *   410 `note_gone`: the note was deleted in the meantime.
 */
export async function saveIssueUrl(
  store: NotesStore,
  subject: string,
  noteId: string,
  issue: { url: string; number: number },
): Promise<{ ok: true; note: Note } | { ok: false; res: Response }> {
  let note: Note | null;
  try {
    note = await store.setIssueUrl(subject, noteId, issue.url);
  } catch {
    logIssue("issue.url_not_saved", { note: noteId, issue: issue.number }, "warn");
    const message = "The issue was created, but the link could not be saved on this note.";
    return { ok: false, res: fail(500, "issue_url_not_saved", message, { issue }) };
  }
  if (!note) {
    logIssue("issue.note_gone", { note: noteId, issue: issue.number }, "warn");
    const message = "The issue was created, but the link could not be saved on this note: the note is gone.";
    return { ok: false, res: fail(410, "note_gone", message, { issue }) };
  }
  return { ok: true, note };
}

/** One log line: ids, counts and token usage only. */
export function logIssue(
  msg: string,
  fields: Record<string, string | number | boolean>,
  level: "info" | "warn" = "info",
) {
  const line = JSON.stringify({ app: "docs", level, msg, ...fields });
  if (level === "warn") console.warn(line);
  else console.info(line);
}
