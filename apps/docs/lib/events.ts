/**
 * The events docs publishes (Flow, ADR 0001). The publisher checks every payload against the JSON
 * Schema the manifest references before anything is written; lib/notes.ts publishes inside the
 * note's own transaction, lib/issue-draft-handler.ts inside the inbox transaction of Flow's request. Each event carries the W3C trace context of the request that caused it;
 * with telemetry off it carries none.
 */
import { createPublisher } from "@asafarim/app-sdk/events";
import { activeTraceContext } from "@asafarim/telemetry";
import manifest from "../platform.app";
import { EVENT_SCHEMAS } from "./schemas";

export const NOTE_CREATED = "docs.note.created.v1";

/** What `docs.note.created.v1` carries (events/docs.note.created.v1.json): never the body or the quote. */
export interface NoteCreatedV1 {
  id: string;
  author: string;
  docPath: string;
  tags: string[];
  hasIssue: boolean;
  createdAt: string;
}

export const ISSUE_DRAFT_READY = "docs.issue-draft.ready.v1";
export const ISSUE_DRAFT_FAILED = "docs.issue-draft.failed.v1";

/** What `docs.issue-draft.ready.v1` carries (events/docs.issue-draft.ready.v1.json). */
export interface IssueDraftReadyV1 {
  runId: string;
  stepId: string;
  /** The id of the flow.issue-draft.requested.v1 event this answers. */
  requestId: string;
  noteId: string;
  docPath: string;
  repo: string;
  public: boolean;
  title: string;
  body: string;
  labels: string[];
}

export const ISSUE_DRAFT_FAILURES = [
  "note_not_found",
  "forbidden",
  "issue_exists",
  "no_repo_access",
  "invalid_ai_answer",
  "ai_unavailable",
] as const;
export type IssueDraftFailure = (typeof ISSUE_DRAFT_FAILURES)[number];

/** What `docs.issue-draft.failed.v1` carries (events/docs.issue-draft.failed.v1.json). */
export interface IssueDraftFailedV1 {
  runId: string;
  stepId: string;
  /** The id of the flow.issue-draft.requested.v1 event this answers. */
  requestId: string;
  noteId: string;
  code: IssueDraftFailure;
  /** Short; never the note's text, a token or a stack trace. */
  message: string;
}

export const publisher = createPublisher({
  manifest,
  schemas: EVENT_SCHEMAS,
  traceContext: activeTraceContext,
});
