/** Conditions: equals, notEquals and contains, on trigger fields and earlier steps' output. */
import { describe, expect, it } from "vitest";
import { evaluate, holds } from "../lib/workflow/conditions";
import { resolveField, type RunContext } from "../lib/workflow/context";
import type { Clause } from "../lib/workflow/definition";

const ctx: RunContext = {
  runId: "R",
  trigger: {
    tags: ["issue", "idea"],
    hasIssue: false,
    docPath: "guides/getting-started.md",
    count: 3,
    nested: { a: { b: "x" } },
  },
  steps: { draft: { output: { labels: ["bug"], title: "Fix it" } } },
};
const c = (field: string, op: Clause["op"], value: Clause["value"]): Clause => ({ field, op, value });

describe("fields", () => {
  it("reads trigger.* and steps.<key>.output.*, nested", () => {
    expect(resolveField(ctx, "trigger.tags")).toEqual(["issue", "idea"]);
    expect(resolveField(ctx, "trigger.nested.a.b")).toBe("x");
    expect(resolveField(ctx, "steps.draft.output.title")).toBe("Fix it");
    expect(resolveField(ctx, "steps.draft.output")).toEqual({ labels: ["bug"], title: "Fix it" });
  });

  it("a missing part is undefined, never a prototype's property", () => {
    expect(resolveField(ctx, "trigger.missing.deeper")).toBeUndefined();
    expect(resolveField(ctx, "trigger.tags.length")).toBeUndefined();
    expect(resolveField(ctx, "trigger.constructor")).toBeUndefined();
    expect(resolveField(ctx, "steps.review.output.x")).toBeUndefined();
    expect(resolveField(ctx, "steps.draft.input")).toBeUndefined();
  });
});

describe("operators", () => {
  it("equals and notEquals: strict, a missing field equals nothing", () => {
    expect(holds(c("trigger.hasIssue", "equals", false), ctx)).toBe(true);
    expect(holds(c("trigger.count", "equals", "3"), ctx)).toBe(false);
    expect(holds(c("trigger.missing", "equals", null), ctx)).toBe(false);
    expect(holds(c("trigger.missing", "notEquals", "x"), ctx)).toBe(true);
    expect(holds(c("trigger.hasIssue", "notEquals", false), ctx)).toBe(false);
  });

  it("contains: an array item or a substring; anything else contains nothing", () => {
    expect(holds(c("trigger.tags", "contains", "issue"), ctx)).toBe(true);
    expect(holds(c("trigger.tags", "contains", "iss"), ctx)).toBe(false);
    expect(holds(c("trigger.docPath", "contains", "guides/"), ctx)).toBe(true);
    expect(holds(c("trigger.count", "contains", 3), ctx)).toBe(false);
    expect(holds(c("trigger.missing", "contains", "x"), ctx)).toBe(false);
    expect(holds(c("steps.draft.output.labels", "contains", "bug"), ctx)).toBe(true);
  });

  it("all clauses must hold; the values read are the step's input", () => {
    expect(evaluate([c("trigger.tags", "contains", "issue"), c("trigger.hasIssue", "equals", false)], ctx)).toEqual({
      passed: true,
      fields: { "trigger.tags": ["issue", "idea"], "trigger.hasIssue": false },
    });
    expect(evaluate([c("trigger.tags", "contains", "issue"), c("trigger.hasIssue", "equals", true)], ctx).passed).toBe(
      false,
    );
    expect(evaluate([c("trigger.missing", "notEquals", 1)], ctx).fields).toEqual({ "trigger.missing": null });
  });
});
