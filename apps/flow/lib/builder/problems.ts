/**
 * The problems validation found (lib/builder/checks.ts), each placed on what it is about: a node (by
 * its canvas id), the trigger (its fields and `start`, which the trigger's panel sets), or the workflow
 * as a whole. Pure.
 */
import { nodeIds, TRIGGER_ID } from "./canvas";
import { keyOf } from "./graph";
import type { Draft, Problem } from "./types";

/** The workflow-wide problems' place. */
export const WORKFLOW = "";

export function placeOf(draft: Draft, problem: Problem): string {
  const ids = nodeIds(draft);
  if (problem.node !== undefined) {
    const index = /^#(\d+)$/.exec(problem.node);
    if (index) return ids[Number(index[1])] ?? WORKFLOW;
    const i = draft.nodes.findIndex((n) => keyOf(n) === problem.node);
    return i >= 0 ? ids[i]! : WORKFLOW;
  }
  if (problem.path === "start" || problem.path === "trigger" || problem.path.startsWith("trigger.")) return TRIGGER_ID;
  const nodeAt = /^nodes\.(\d+)(?:\.|$)/.exec(problem.path);
  if (nodeAt) return ids[Number(nodeAt[1])] ?? WORKFLOW;
  return WORKFLOW;
}

/** The problems by where they go; every problem is in exactly one list. */
export function problemsByPlace(draft: Draft, problems: readonly Problem[]): Map<string, Problem[]> {
  const out = new Map<string, Problem[]>();
  for (const p of problems) {
    const at = placeOf(draft, p);
    out.set(at, [...(out.get(at) ?? []), p]);
  }
  return out;
}

/** `input.to.0: …` without the node: the field it is about, then what is wrong. */
export const fieldProblemText = (p: Problem) => (p.path ? `${p.path}: ${p.message}` : p.message);
