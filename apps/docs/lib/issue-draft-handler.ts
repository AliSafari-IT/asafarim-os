import "server-only";
/**
 * Docs answers Flow's `flow.issue-draft.requested.v1` (ADR 0001, Flow PR 4a): it drafts a GitHub
 * issue from the note, with the same code as "Generate GitHub issue" (lib/issue-drafting.ts), and
 * publishes `docs.issue-draft.ready.v1` or `docs.issue-draft.failed.v1` through the outbox, in the
 * request's own inbox transaction (lib/subscribers.ts), so an answer exists exactly when the
 * request counts as handled. Every answer carries the request's event id as `requestId`.
 * Nothing is created on GitHub.
 *
 * In order: an invalid payload is logged and acked (never retried); a note that isn't the
 * subject's is `note_not_found` (another author's note is never revealed); the subject needs
 * docs.read and docs.issues.create now (`forbidden`), and a permission check that can't be made
 * (`AccessUnavailableError`) is thrown, so the request is redelivered and nothing is answered; a
 * note with an issue is `issue_exists`. GitHub's 401/403/404 is `no_repo_access`, an AI answer
 * that fails validation `invalid_ai_answer`, an AI timeout, network error, 429 or 5xx
 * `ai_unavailable`. Anything else is thrown (redelivered with a backoff, then dead-lettered).
 * The note is read without a row lock: the transaction stays open during the AI call (up to 60 s).
 */
import type { CloudEvent, Queryable } from "@asafarim/app-sdk/events";
import { z } from "zod";
import {
  ISSUE_DRAFT_FAILED,
  ISSUE_DRAFT_READY,
  publisher,
  type IssueDraftFailedV1,
  type IssueDraftFailure,
  type IssueDraftReadyV1,
} from "./events";
import {
  AiNoIssueError,
  AiTimeoutError,
  AiUnavailableError,
  getIssueTracker,
  getIssueWriter,
  NoRepoAccessError,
  type IssueTracker,
  type IssueWriter,
} from "./issue-clients";
import { draftIssue, loadNoteDocument, logIssue } from "./issue-drafting";
import { findNote } from "./notes";
import { getPlatform } from "./platform";

export const ISSUE_DRAFT_REQUESTED = "flow.issue-draft.requested.v1";

const Id = z.string().min(1).max(64);

/** Flow's events/flow.issue-draft.requested.v1.json, as Docs reads it. */
export const IssueDraftRequest = z.strictObject({
  runId: Id,
  stepId: Id,
  noteId: Id,
  onBehalfOf: z.string().min(1).max(200),
});

/** What the event contract allows a draft (events/docs.issue-draft.ready.v1.json). */
const MAX_TITLE = 256;
const MAX_BODY = 60_000;
const MAX_LABELS = 20;

export interface IssueDraftDeps {
  /** Never cached; throws `AccessUnavailableError` when it can't answer (app-sdk). */
  subjectHas(subject: string, permission: string): Promise<boolean>;
  /** null: not configured (DOCS_ISSUES_TOKEN / DOCS_AI_API_KEY). */
  tracker(): IssueTracker | null;
  writer(): IssueWriter | null;
  loadDocument(docPath: string): Promise<{ markdown: string; ownerRepo: string }>;
}

export const defaultIssueDraftDeps = (): IssueDraftDeps => ({
  subjectHas: (subject, permission) => getPlatform().access.subjectHas(subject, permission),
  tracker: getIssueTracker,
  writer: () => getIssueWriter(getPlatform().config.getString("ai.model")),
  loadDocument: loadNoteDocument,
});

/** The failure an outside call's error maps to, or undefined when it isn't one to answer (thrown again). */
export function failureOf(err: unknown): { code: IssueDraftFailure; message: string } | undefined {
  if (err instanceof NoRepoAccessError) return { code: "no_repo_access", message: `No access to ${err.repo}` };
  if (err instanceof AiNoIssueError)
    return { code: "invalid_ai_answer", message: "The AI's answer wasn't a usable issue." };
  if (err instanceof AiTimeoutError) return { code: "ai_unavailable", message: "The AI took too long to answer." };
  if (err instanceof AiUnavailableError && (err.status === undefined || err.status === 429 || err.status >= 500)) {
    return { code: "ai_unavailable", message: "The AI isn't answering." };
  }
  return undefined;
}

/** The handler for `flow.issue-draft.requested.v1`: `tx` is the inbox transaction the answer is written in. */
export function createIssueDraftHandler(deps: IssueDraftDeps = defaultIssueDraftDeps()) {
  return async (event: CloudEvent, tx: Queryable): Promise<void> => {
    const req = IssueDraftRequest.safeParse(event.data);
    if (!req.success) {
      // Retrying can't fix it: acked with the inbox row, never answered (there may be no run to answer).
      logIssue("issue.draft_request_invalid", { event: event.id }, "warn");
      return;
    }
    const { runId, stepId, noteId, onBehalfOf } = req.data;
    const ids = { runId, stepId, requestId: event.id, noteId };

    const fail = async (code: IssueDraftFailure, message: string) => {
      await publisher.publish<IssueDraftFailedV1>(
        tx,
        ISSUE_DRAFT_FAILED,
        { ...ids, code, message },
        { subject: noteId },
      );
      logIssue("issue.draft_request", { event: event.id, run: runId, note: noteId, outcome: code });
    };

    const note = await findNote(tx, onBehalfOf, noteId);
    if (!note) return fail("note_not_found", "No such note.");
    // Both asked every time (never cached); an outage throws, so the request is redelivered.
    const [read, create] = await Promise.all([
      deps.subjectHas(onBehalfOf, "docs.read"),
      deps.subjectHas(onBehalfOf, "docs.issues.create"),
    ]);
    if (!read || !create) {
      return fail("forbidden", `Missing the permission ${read ? "docs.issues.create" : "docs.read"}.`);
    }
    if (note.issueUrl) return fail("issue_exists", "This note already has an issue.");
    // Not set up (no DOCS_ISSUES_TOKEN / DOCS_AI_API_KEY): no answer the contract has; thrown, so the
    // request is retried and dead-lettered, and Flow's step waits (until its own timeout).
    const tracker = deps.tracker();
    if (!tracker) throw new Error("docs: issues aren't set up on this server (DOCS_ISSUES_TOKEN)");
    const writer = deps.writer();
    if (!writer) throw new Error("docs: the AI isn't set up on this server (DOCS_AI_API_KEY)");

    const doc = await deps.loadDocument(note.docPath);
    let draft;
    try {
      draft = await draftIssue({ note, markdown: doc.markdown, repo: doc.ownerRepo, tracker, writer });
    } catch (err) {
      const failure = failureOf(err);
      if (!failure) throw err;
      return fail(failure.code, failure.message);
    }
    if (!draft.ok) return fail("invalid_ai_answer", "The AI's answer wasn't a usable issue.");
    const { title, body, labels } = draft.draft;
    // Replacing links with the document's path can lengthen a valid answer past what the event allows.
    if (title.length > MAX_TITLE || body.length > MAX_BODY || labels.length > MAX_LABELS) {
      return fail("invalid_ai_answer", "The AI's answer was too long for an issue.");
    }

    await publisher.publish<IssueDraftReadyV1>(
      tx,
      ISSUE_DRAFT_READY,
      { ...ids, docPath: note.docPath, repo: draft.repo, public: draft.public, title, body, labels },
      { subject: noteId },
    );
    logIssue("issue.draft_request", { event: event.id, run: runId, note: noteId, outcome: "ready" });
  };
}
