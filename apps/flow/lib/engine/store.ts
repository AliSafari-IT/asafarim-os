/**
 * What the engine reads and writes, always through the transaction it runs in. lib/engine/pg-store.ts
 * is the Postgres implementation; the unit tests use an in-memory one.
 *
 * Locking rule: every change to a run or its steps happens while the transaction holds the run's row
 * lock (`lockRun`), so an outcome, a decision, the sweeper, a retry and a cancel never interleave on one
 * run. That includes its approvals.
 */
import type { Queryable } from "@asafarim/app-sdk/events";
import type { WorkflowDefinition } from "../workflow/definition";

export type Tx = Queryable;

export const RUN_STATUSES = ["running", "waiting", "succeeded", "failed", "skipped", "rejected", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const STEP_STATUSES = ["pending", "running", "waiting", "succeeded", "failed", "timed_out", "skipped"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
export type WorkflowStatus = "active" | "paused";
export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired", "cancelled"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** A run in one of these has ended (`ended_at` is set). */
export const ENDED: readonly RunStatus[] = ["succeeded", "failed", "skipped", "rejected", "cancelled"];

export interface WorkflowRow {
  id: string;
  key: string;
  name: string;
  status: WorkflowStatus;
}

export interface VersionRow {
  id: string;
  workflowId: string;
  version: number;
  definition: WorkflowDefinition;
  publishedAt: Date;
}

export interface RunRow {
  id: string;
  versionId: string;
  triggerEventId: string;
  trigger: Record<string, unknown>;
  status: RunStatus;
  startedAt: Date;
  endedAt: Date | null;
  errorCode: string | null;
}

export interface StepRow {
  id: string;
  runId: string;
  stepKey: string;
  status: StepStatus;
  requestEventId: string | null;
  outcomeEventId: string | null;
  input: unknown;
  output: unknown;
  attempts: number;
  startedAt: Date | null;
  endedAt: Date | null;
  timeoutAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/** A person's decision on an approval step: one row per time the step is reached. */
export interface ApprovalRow {
  id: string;
  runId: string;
  stepId: string;
  status: ApprovalStatus;
  /** The role the definition names (informational: deciding needs flow.approvals.decide). */
  assigneeRole: string;
  deadline: Date | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  comment: string | null;
  /** The fields the approver changed, with their new values; null when nothing changed. */
  edited: Record<string, unknown> | null;
  createdAt: Date;
}

export type RunPatch = Partial<Pick<RunRow, "status" | "endedAt" | "errorCode">>;
export type StepPatch = Partial<Omit<StepRow, "id" | "runId" | "stepKey">>;
export type ApprovalPatch = Partial<Pick<ApprovalRow, "status" | "decidedBy" | "decidedAt" | "comment" | "edited">>;

export interface FlowStore {
  /** Active workflows whose CURRENT version (the highest) is triggered by `eventType`. */
  triggeredBy(eventType: string): Promise<{ workflow: WorkflowRow; version: VersionRow }[]>;
  /** Insert a run; null when a run for this trigger event already exists. */
  createRun(run: RunRow): Promise<RunRow | null>;
  /** The run, locked for this transaction (FOR UPDATE). */
  lockRun(id: string): Promise<RunRow | undefined>;
  updateRun(id: string, patch: RunPatch): Promise<void>;
  version(id: string): Promise<VersionRow | undefined>;
  workflowOf(versionId: string): Promise<WorkflowRow | undefined>;
  /** The run's steps, in the order they were first reached. */
  steps(runId: string): Promise<StepRow[]>;
  insertStep(step: StepRow): Promise<void>;
  updateStep(id: string, patch: StepPatch): Promise<void>;
  insertApproval(approval: ApprovalRow): Promise<void>;
  approval(id: string): Promise<ApprovalRow | undefined>;
  /** The run's approvals, oldest first. */
  approvalsOf(runId: string): Promise<ApprovalRow[]>;
  updateApproval(id: string, patch: ApprovalPatch): Promise<void>;
  /**
   * One waiting run with a waiting step whose `timeout_at` has passed, or a pending approval whose
   * `deadline` has, locked (FOR UPDATE SKIP LOCKED: another instance's sweeper skips it). Undefined
   * when there is none.
   */
  claimOverdueRun(now: Date): Promise<string | undefined>;
  /** Set a workflow's status; its previous status, or undefined when there is no such workflow. */
  setWorkflowStatus(key: string, status: WorkflowStatus): Promise<WorkflowStatus | undefined>;
}
