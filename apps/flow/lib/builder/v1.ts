/**
 * A version 1 definition as version 2, the builder's format: what editing a v1 workflow starts its
 * draft from. It runs the same way (lib/workflow/graph.ts reads v1 like this): steps in order, a false
 * condition ends the run `skipped`, an approval reviews the draft before it, the issue is created from
 * the approval before it. Its actions are the two Docs nodes, the only requests v1 can make.
 */
import { DOCS_NODES, type WorkflowDefinition } from "../workflow/definition";
import type { Draft, RawNode } from "./types";

const DOCS_TYPE_OF = Object.fromEntries(Object.entries(DOCS_NODES).map(([type, io]) => [io.request, type]));

export function v1ToV2(def: WorkflowDefinition): Draft {
  const keys = new Set(def.steps.map((s) => s.key));
  let skipped = "skipped";
  for (let i = 2; keys.has(skipped); i++) skipped = `skipped-${i}`;
  let lastDraft: string | undefined;
  let lastApproval: string | undefined;
  let needsSkip = false;
  const nodes: RawNode[] = def.steps.map((step, i) => {
    const next = def.steps[i + 1]?.key;
    const onward = next === undefined ? {} : { next };
    switch (step.type) {
      case "condition":
        needsSkip = true;
        return { key: step.key, type: "condition", all: step.all, ...(next ? { then: next } : {}), else: skipped };
      case "action": {
        const type = DOCS_TYPE_OF[step.request] ?? step.request;
        const node: RawNode =
          type === "docs.issue-create"
            ? { key: step.key, type, approval: lastApproval ?? "", timeout: step.timeout, ...onward }
            : { key: step.key, type, timeout: step.timeout, ...onward };
        if (type === "docs.issue-draft") lastDraft = step.key;
        return node;
      }
      case "approval": {
        lastApproval = step.key;
        return {
          key: step.key,
          type: "approval",
          role: step.role,
          deadline: step.deadline,
          onExpire: step.onExpire,
          ...(lastDraft ? { draft: lastDraft } : {}),
          editable: step.editable,
          ...onward,
        };
      }
      case "end":
        return { key: step.key, type: "end" };
    }
  });
  if (needsSkip) nodes.push({ key: skipped, type: "end", status: "skipped" });
  return {
    version: 2,
    key: def.key,
    trigger: { type: "event", event: def.trigger.event },
    start: def.steps[0]?.key ?? "",
    nodes,
  };
}
