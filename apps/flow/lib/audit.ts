/**
 * Flow's audit trail: one JSON line per action (`audit: true`), through the app's logger, the way the
 * OS apps report what they do. Ids only (run, step, approval, workflow key, the acting subject), never a
 * payload, a draft, a note or anything a person wrote. The engine returns the entries of a transition and they are
 * written once its transaction has committed.
 */
import { log } from "./log";

export type AuditAction =
  | "flow.run.started"
  | "flow.run.finished"
  | "flow.run.retried"
  | "flow.run.cancelled"
  | "flow.approval.decided"
  | "flow.workflow.paused"
  | "flow.workflow.resumed"
  | "flow.workflow.draft_saved"
  | "flow.workflow.published"
  /** A new workflow made from another's definition (the builder's Duplicate). */
  | "flow.workflow.duplicated"
  /** A trigger arrived while Settings `paused_all` was on: no run started. */
  | "flow.run.refused"
  | "flow.all.paused"
  | "flow.all.resumed"
  | "flow.settings.changed"
  | "flow.credential.created"
  | "flow.credential.rotated"
  | "flow.credential.deleted"
  | "flow.hook.created"
  | "flow.hook.rotated"
  | "flow.hook.deleted"
  /** A draft generated from an issue with AI was asked for (#283): ids and counts, never text. */
  | "flow.workflow.generated";

export interface AuditEntry {
  action: AuditAction;
  runId?: string;
  stepId?: string;
  approvalId?: string;
  /** What the approver decided (flow.approval.decided). */
  decision?: "approved" | "rejected";
  workflow?: string;
  /** The workflow's id (its key may be reused once it is gone; the id never is). */
  workflowId?: string;
  /** flow.workflow.duplicated: the workflow it was made from (its key and id). */
  source?: string;
  sourceId?: string;
  version?: number;
  triggerEventId?: string;
  /** How a run ended (flow.run.finished). */
  status?: string;
  errorCode?: string;
  attempt?: number;
  /** A test run, and a dry one (flow.run.started). */
  test?: boolean;
  dryRun?: boolean;
  /** A credential's id and kind; never its name, its meta or its secret. */
  credentialId?: string;
  kind?: string;
  /** A hook's id (flow.hook.*): it is in the hook's URL, never its secret. */
  hookId?: string;
  /** The setting that changed, and how many entries its list holds now (flow.settings.changed). */
  setting?: string;
  count?: number;
  /** ai_generation (flow.settings.changed): on or off. */
  enabled?: boolean;
  /** flow.workflow.generated: the issue (host, repository path, number), never its URL or text. */
  sourceHost?: string;
  sourceRepo?: string;
  sourceNumber?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** How the generation ended: ok, or the error code. */
  outcome?: string;
  /** The subject who did it; absent when the engine did it on its own. */
  actor?: string;
}

export function writeAudit(entries: readonly AuditEntry[]): void {
  for (const { action, ...ids } of entries) log.info(action, { audit: true, ...ids });
}
