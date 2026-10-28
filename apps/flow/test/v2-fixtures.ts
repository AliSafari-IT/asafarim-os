/** v2 definitions the tests share. */
import type { WorkflowDefinitionV2 } from "../lib/workflow/definition-v2";

/** manual → condition → test.echo → end (the condition's else goes straight to the end). */
export const ECHO_FLOW = {
  version: 2,
  key: "echo-flow",
  trigger: {
    type: "manual",
    input: [
      { name: "name", type: "string", required: true },
      { name: "loud", type: "boolean" },
    ],
  },
  start: "check",
  nodes: [
    {
      key: "check",
      type: "condition",
      all: [{ field: "trigger.loud", op: "equals", value: true }],
      then: "shout",
      else: "done",
    },
    { key: "shout", type: "test.echo", input: { text: "Hello {{trigger.name}}!" }, next: "done" },
    { key: "done", type: "end" },
  ],
  layout: { check: { x: 0, y: 0 }, shout: { x: 200, y: 0 }, done: { x: 400, y: 0 } },
} as const;

/** Slice 1 as a v2 graph: a #issue note → Docs drafts → a person approves → Docs creates the issue. */
export const DOCS_FLOW = {
  version: 2,
  key: "docs-note-to-issue-v2",
  trigger: { type: "event", event: "docs.note.created.v1" },
  start: "only-tagged",
  nodes: [
    {
      key: "only-tagged",
      type: "condition",
      all: [{ field: "trigger.tags", op: "contains", value: "issue" }],
      then: "draft",
      else: "not-tagged",
    },
    { key: "draft", type: "docs.issue-draft", next: "review" },
    {
      key: "review",
      type: "approval",
      role: "flow.approver",
      deadline: "P7D",
      onExpire: "stop",
      draft: "draft",
      editable: ["title"],
      next: "create",
    },
    { key: "create", type: "docs.issue-create", approval: "review", next: "end" },
    { key: "end", type: "end" },
    { key: "not-tagged", type: "end", status: "skipped" },
  ],
} as const;

/** A copy to change in a test. */
export const clone = <T>(v: T): T & Record<string, unknown> => structuredClone(v) as T & Record<string, unknown>;

export type V2 = WorkflowDefinitionV2;
