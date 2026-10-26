/**
 * The workflows Flow ships with, stored as version 1 on first start (lib/db.ts, idempotent). A later
 * change to one of them is a new version, never an edit of version 1.
 */
import type { WorkflowDefinition } from "./definition";

export interface SeedWorkflow {
  name: string;
  definition: WorkflowDefinition;
}

/** Slice 1 (ADR 0001): `#issue` in a Docs study note → Docs drafts an issue → approve → Docs creates it. */
export const DOCS_NOTE_TO_ISSUE: SeedWorkflow = {
  name: "Docs note to GitHub issue",
  definition: {
    key: "docs-note-to-issue",
    trigger: { event: "docs.note.created.v1" },
    steps: [
      {
        key: "only-tagged",
        type: "condition",
        all: [
          { field: "trigger.tags", op: "contains", value: "issue" },
          { field: "trigger.hasIssue", op: "equals", value: false },
        ],
      },
      {
        key: "draft",
        type: "action",
        request: "flow.issue-draft.requested.v1",
        done: "docs.issue-draft.ready.v1",
        failed: "docs.issue-draft.failed.v1",
        timeout: "PT5M",
      },
      {
        key: "review",
        type: "approval",
        role: "flow.approver",
        deadline: "P7D",
        onExpire: "stop",
        editable: ["title", "body", "labels"],
      },
      {
        key: "create",
        type: "action",
        request: "flow.issue.approved.v1",
        done: "docs.issue.created.v1",
        failed: "docs.issue.failed.v1",
        timeout: "PT5M",
      },
      { key: "end", type: "end" },
    ],
  },
};

export const SEED_WORKFLOWS: readonly SeedWorkflow[] = [DOCS_NOTE_TO_ISSUE];
