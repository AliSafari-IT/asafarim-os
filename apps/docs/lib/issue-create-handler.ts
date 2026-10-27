import "server-only";
/**
 * Docs answers Flow's `flow.issue.approved.v1` (ADR 0001, Flow PR 5): it creates the GitHub issue the
 * owner approved in Flow, with the same code as "Create issue" (lib/issue-create.ts), saves its URL on
 * the note and publishes `docs.issue.created.v1`, or publishes `docs.issue.failed.v1`, in the
 * request's own inbox transaction (lib/subscribers.ts). Every answer carries the request's event id
 * as `requestId`.
 *
 * In order: an invalid payload is logged and acked (never retried); a note that isn't the subject's
 * is `note_not_found`; the subject needs docs.read and docs.issues.create now (`forbidden`), and a
 * permission check that can't be made (`AccessUnavailableError`) is thrown, so the request is
 * redelivered and nothing is answered; a note with an issue is `issue_exists` (Flow never confirms a
 * second one); a public repo (asked now) without `acknowledgedPublic` is `public_not_acknowledged`;
 * a link to the reader or a label the repo doesn't have is `invalid_issue`. GitHub's 401/403/404 is
 * `no_repo_access`, a 5xx or timeout `github_unavailable`; anything else is thrown (redelivered with a
 * backoff, then dead-lettered), as is a server without DOCS_ISSUES_TOKEN.
 *
 * No duplicate issue after a crash: GitHub is outside the inbox transaction, so before asking it to
 * create anything the approval id is recorded on the note in a write committed on its own, and the
 * issue's body ends with a hidden marker naming the approval. A redelivery that finds that approval
 * recorded but no issue URL first looks for the marker among the issues the token's user opened in
 * the repo since then, and reuses the issue it finds.
 */
import type { CloudEvent, Queryable } from "@asafarim/app-sdk/events";
import { z } from "zod";
import {
  ISSUE_CREATED,
  ISSUE_FAILED,
  publisher,
  type IssueCreatedV1,
  type IssueFailedV1,
  type IssueFailure,
} from "./events";
import { getIssueTracker, GitHubUnavailableError, NoRepoAccessError, type IssueTracker } from "./issue-clients";
import { createIssue } from "./issue-create";
import { logIssue } from "./issue-drafting";
import { findNote, getNotes, saveFlowIssueUrl } from "./notes";
import { getPlatform } from "./platform";

export const ISSUE_APPROVED = "flow.issue.approved.v1";

const Id = z.string().min(1).max(64);
const Subject = z.string().min(1).max(200);

/** Flow's events/flow.issue.approved.v1.json, as Docs reads it. */
export const IssueApproved = z.strictObject({
  runId: Id,
  stepId: Id,
  approvalId: Id,
  noteId: Id,
  onBehalfOf: Subject,
  decidedBy: Subject,
  decidedAt: z.iso.datetime({ offset: true }),
  // Flow's own pattern (its schema), so nothing Flow may send is dropped as invalid here.
  repo: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/),
  title: z.string().min(1).max(256),
  body: z.string().max(60_000),
  labels: z
    .array(z.string().min(1).max(50))
    .max(20)
    .refine((l) => new Set(l).size === l.length, "labels must be distinct"),
  acknowledgedPublic: z.boolean(),
});

/** The hidden line that ends the body of an issue created for Flow's approval `approvalId`. */
export const approvalMarker = (approvalId: string) => `<!-- asafarim-flow:${approvalId} -->`;

/** GitHub's `since` is compared with its own clock: look this far before the recorded time. */
const CLOCK_SKEW_MS = 5 * 60_000;

export interface IssueCreateDeps {
  /** Never cached; throws `AccessUnavailableError` when it can't answer (app-sdk). */
  subjectHas(subject: string, permission: string): Promise<boolean>;
  /** null: not configured (DOCS_ISSUES_TOKEN). */
  tracker(): IssueTracker | null;
  /** Records the approval on the note, committed on its own (never the inbox transaction). */
  recordApproval(author: string, noteId: string, approvalId: string): Promise<boolean>;
}

export const defaultIssueCreateDeps = (): IssueCreateDeps => ({
  subjectHas: (subject, permission) => getPlatform().access.subjectHas(subject, permission),
  tracker: getIssueTracker,
  recordApproval: async (author, noteId, approvalId) => {
    const store = getNotes();
    if (!store) throw new Error("docs: notes aren't available (DATABASE_URL)");
    return store.recordFlowApproval(author, noteId, approvalId);
  },
});

/** The failure GitHub's error maps to, or undefined when it isn't one to answer (thrown again). */
export function githubFailure(err: unknown): { code: IssueFailure; message: string } | undefined {
  if (err instanceof NoRepoAccessError) return { code: "no_repo_access", message: `No access to ${err.repo}` };
  if (err instanceof GitHubUnavailableError) return { code: "github_unavailable", message: "GitHub isn't answering." };
  return undefined;
}

/** The handler for `flow.issue.approved.v1`: `tx` is the inbox transaction the answer is written in. */
export function createIssueCreateHandler(deps: IssueCreateDeps = defaultIssueCreateDeps()) {
  return async (event: CloudEvent, tx: Queryable): Promise<void> => {
    const req = IssueApproved.safeParse(event.data);
    if (!req.success) {
      // Retrying can't fix it: acked with the inbox row, never answered (there may be no run to answer).
      logIssue("issue.create_request_invalid", { event: event.id }, "warn");
      return;
    }
    const { runId, stepId, approvalId, noteId, onBehalfOf } = req.data;
    const ids = { runId, stepId, requestId: event.id, noteId };
    const log = (outcome: string, extra: Record<string, string | number | boolean> = {}) =>
      logIssue("issue.create_request", { event: event.id, run: runId, note: noteId, outcome, ...extra });

    const fail = async (code: IssueFailure, message: string) => {
      await publisher.publish<IssueFailedV1>(tx, ISSUE_FAILED, { ...ids, code, message }, { subject: noteId });
      log(code);
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
    // Not set up: no answer the contract has; thrown, so the request is retried and dead-lettered.
    const tracker = deps.tracker();
    if (!tracker) throw new Error("docs: issues aren't set up on this server (DOCS_ISSUES_TOKEN)");

    const marker = approvalMarker(approvalId);
    // This approval was recorded by an earlier delivery that never committed its answer: GitHub may
    // already have its issue.
    const since =
      note.flowApprovalId === approvalId && note.flowApprovalAt
        ? new Date(Date.parse(note.flowApprovalAt) - CLOCK_SKEW_MS)
        : undefined;
    let reused = false;
    let created;
    try {
      created = await createIssue(tracker, req.data, {
        unknownLabels: "refuse",
        create: async (target, issue) => {
          if (since) {
            const found = await tracker.findByMarker(target, marker, since);
            if (found) {
              reused = true;
              return found;
            }
          } else if (!(await deps.recordApproval(onBehalfOf, noteId, approvalId))) {
            throw new Error("docs: the note disappeared before its approval was recorded");
          }
          return tracker.create(target, { ...issue, body: `${issue.body}\n\n${marker}` });
        },
      });
    } catch (err) {
      const failure = githubFailure(err);
      if (!failure) throw err;
      return fail(failure.code, failure.message);
    }
    if (!created.ok) return fail(created.error, created.message);

    const saved = await saveFlowIssueUrl(tx, onBehalfOf, noteId, created.issue.url);
    // Deleted meanwhile: the issue exists all the same, and that's what the run waits for.
    if (!saved) logIssue("issue.note_gone", { note: noteId, issue: created.issue.number }, "warn");
    await publisher.publish<IssueCreatedV1>(
      tx,
      ISSUE_CREATED,
      { ...ids, issueUrl: created.issue.url },
      { subject: noteId },
    );
    log("created", { issue: created.issue.number, reused, labels: created.labels.length });
  };
}
