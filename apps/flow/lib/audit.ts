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
  | "flow.workflow.resumed";

export interface AuditEntry {
  action: AuditAction;
  runId?: string;
  stepId?: string;
  approvalId?: string;
  /** What the approver decided (flow.approval.decided). */
  decision?: "approved" | "rejected";
  workflow?: string;
  version?: number;
  triggerEventId?: string;
  /** How a run ended (flow.run.finished). */
  status?: string;
  errorCode?: string;
  attempt?: number;
  /** The subject who did it; absent when the engine did it on its own. */
  actor?: string;
}

export function writeAudit(entries: readonly AuditEntry[]): void {
  for (const { action, ...ids } of entries) log.info(action, { audit: true, ...ids });
}
