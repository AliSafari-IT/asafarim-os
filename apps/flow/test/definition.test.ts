/**
 * The workflow definition format: the shipped workflow is valid and fits the manifest; what the
 * format refuses; and the durations it accepts.
 */
import { describe, expect, it } from "vitest";
import manifest from "../platform.app";
import { manifestProblems, parseDefinition, type WorkflowDefinition } from "../lib/workflow/definition";
import { durationMs } from "../lib/workflow/duration";
import { DOCS_NOTE_TO_ISSUE, SEED_WORKFLOWS } from "../lib/workflow/seed";

const base = DOCS_NOTE_TO_ISSUE.definition;
const withSteps = (steps: unknown[]) => ({ ...base, steps });
const problems = (value: unknown) => {
  const r = parseDefinition(value);
  return r.ok ? [] : r.problems;
};

describe("the shipped workflows", () => {
  it.each(SEED_WORKFLOWS.map((s) => [s.definition.key, s] as const))("%s is valid and fits the manifest", (_, s) => {
    const r = parseDefinition(s.definition);
    expect(r).toEqual({ ok: true, definition: s.definition });
    expect(manifestProblems(s.definition, manifest)).toEqual([]);
  });

  it("docs-note-to-issue is the slice-1 definition of ADR 0001", () => {
    expect(base).toEqual({
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
    });
  });
});

describe("what a definition may not be", () => {
  const end = { key: "end", type: "end" };

  it("an unknown step type or field, or an operator outside equals / notEquals / contains", () => {
    expect(problems(withSteps([{ key: "x", type: "script", code: "…" }, end]))).not.toEqual([]);
    expect(problems(withSteps([{ key: "end", type: "end", extra: 1 }]))).not.toEqual([]);
    expect(
      problems(
        withSteps([{ key: "c", type: "condition", all: [{ field: "trigger.a", op: "matches", value: "x" }] }, end]),
      ),
    ).not.toEqual([]);
  });

  it("a field outside trigger.* and steps.<key>.output.*, or reading a step that comes later", () => {
    const cond = (field: string) => ({ key: "c", type: "condition", all: [{ field, op: "equals", value: 1 }] });
    expect(problems(withSteps([cond("process.env.SECRET"), end])).join()).toMatch(/must be trigger/);
    expect(problems(withSteps([cond("steps.draft.input.x"), end])).join()).toMatch(/must be trigger/);
    expect(problems(withSteps([cond("steps.later.output.x"), end])).join()).toMatch(/isn't an earlier step/);
    expect(problems(withSteps([cond("trigger.tags"), end]))).toEqual([]);
  });

  it("a request type Flow has no mapping for", () => {
    const action = { ...base.steps[1], request: "flow.something.requested.v1" };
    expect(problems(withSteps([action, end])).join()).toMatch(/must be a request Flow can build/);
  });

  it("duplicate keys, done equal to failed, an end that isn't last or no end", () => {
    const action = base.steps[1]!;
    expect(problems(withSteps([action, action, end])).join()).toMatch(/duplicate step key/);
    expect(problems(withSteps([{ ...action, failed: (action as { done: string }).done }, end])).join()).toMatch(
      /must differ from done/,
    );
    expect(problems(withSteps([end, action])).join()).toMatch(/end must be the last step/);
    expect(problems(withSteps([action])).join()).toMatch(/last step must be an end step/);
  });

  it("a timeout or deadline that isn't a duration in days, hours, minutes or seconds", () => {
    for (const timeout of ["5m", "PT0S", "P1M", "P1W", "PT", "P"]) {
      expect(problems(withSteps([{ ...base.steps[1], timeout }, end]))).not.toEqual([]);
    }
  });

  it("names the manifest's gaps: a trigger or outcome not subscribed, a request not published", () => {
    const def: WorkflowDefinition = {
      ...base,
      trigger: { event: "notes.note.created.v1" },
      steps: [
        {
          ...(base.steps[1] as Extract<WorkflowDefinition["steps"][number], { type: "action" }>),
          done: "docs.x.done.v1",
        },
        { key: "end", type: "end" },
      ],
    };
    expect(manifestProblems(def, manifest)).toEqual([
      "the trigger notes.note.created.v1 isn't in events.subscribes",
      "step draft: docs.x.done.v1 isn't in events.subscribes",
    ]);
    expect(manifestProblems(base, { events: {} })).toHaveLength(7); // the trigger, and per action: its request and two outcomes
  });
});

describe("durations", () => {
  it.each([
    ["PT5M", 5 * 60_000],
    ["P7D", 7 * 24 * 3_600_000],
    ["PT30S", 30_000],
    ["P1DT12H", 36 * 3_600_000],
    ["PT1H30M", 90 * 60_000],
  ])("%s is %i ms", (d, ms) => expect(durationMs(d)).toBe(ms));

  it.each(["", "P", "PT", "P0D", "PT5", "5M", "P1Y", "P2W", "-PT5M", "PT5M "])("%j is refused", (d) =>
    expect(durationMs(d)).toBeUndefined(),
  );
});
