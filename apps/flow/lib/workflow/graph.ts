/**
 * What the engine runs: either definition version as one graph of nodes, each with the key of the node
 * after it. A v1 definition is its steps in order (a false condition ends the run `skipped`; an approval
 * reviews the output of the action before it; an action acts on the approval before it). A v2
 * definition names all of that itself.
 */
import { DOCS_NODES, isV2, msOf, type AnyWorkflowDefinition, type Clause } from "./definition";
import { builtin, isConnectorNode } from "./definition-v2";

export type GraphNode =
  /** `else: null`: the run ends `skipped` (v1). */
  | { kind: "condition"; key: string; type: string; all: Clause[]; then: string; else: string | null }
  /** Publish `request`, wait for `done` or `failed`. `approval`: the node whose decision the request carries. */
  | {
      kind: "action";
      key: string;
      type: string;
      request: string;
      done: string;
      failed: string;
      timeoutMs: number;
      approval: string | null;
      next: string;
    }
  /**
   * `draft`: the node whose output the approver reviews (v1: the action before, which may be missing:
   * the step then fails `invalid_draft`); `reviews: "nothing"`: a plain decision (v2 without `draft`).
   */
  | {
      kind: "approval";
      key: string;
      type: string;
      role: string;
      deadlineMs: number;
      editable: ("title" | "body" | "labels")[];
      reviews: "draft" | "nothing";
      draft: string | null;
      next: string;
    }
  | { kind: "wait"; key: string; type: string; durationMs: number; next: string }
  | { kind: "connector"; key: string; type: string; input: Record<string, unknown>; next: string }
  | { kind: "end"; key: string; type: string; status: "succeeded" | "skipped" };

export interface Graph {
  start: string;
  nodes: Map<string, GraphNode>;
  /** In the definition's order (the Run page lists them so). */
  list: GraphNode[];
}

const cache = new WeakMap<AnyWorkflowDefinition, Graph>();

export function graphOf(def: AnyWorkflowDefinition): Graph {
  let g = cache.get(def);
  if (!g) {
    const list = isV2(def) ? fromV2(def) : fromV1(def);
    g = { start: isV2(def) ? def.start : list[0]!.key, nodes: new Map(list.map((n) => [n.key, n])), list };
    cache.set(def, g);
  }
  return g;
}

function fromV1(def: Extract<AnyWorkflowDefinition, { steps: unknown }>): GraphNode[] {
  let lastAction: string | null = null;
  let lastApproval: string | null = null;
  return def.steps.map((step, i) => {
    const next = def.steps[i + 1]?.key ?? "";
    switch (step.type) {
      case "condition":
        return { kind: "condition", key: step.key, type: step.type, all: step.all, then: next, else: null };
      case "action": {
        const node: GraphNode = {
          kind: "action",
          key: step.key,
          type: step.type,
          request: step.request,
          done: step.done,
          failed: step.failed,
          timeoutMs: msOf(step.timeout),
          approval: lastApproval,
          next,
        };
        lastAction = step.key;
        return node;
      }
      case "approval": {
        const node: GraphNode = {
          kind: "approval",
          key: step.key,
          type: step.type,
          role: step.role,
          deadlineMs: msOf(step.deadline),
          editable: step.editable,
          reviews: "draft",
          draft: lastAction,
          next,
        };
        lastApproval = step.key;
        return node;
      }
      case "end":
        return { kind: "end", key: step.key, type: step.type, status: "succeeded" };
    }
  });
}

function fromV2(def: Extract<AnyWorkflowDefinition, { version: 2 }>): GraphNode[] {
  return def.nodes.map((n): GraphNode => {
    if (isConnectorNode(n)) return { kind: "connector", key: n.key, type: n.type, input: n.input, next: n.next };
    const b = builtin(n)!;
    switch (b.type) {
      case "condition":
        return { kind: "condition", key: b.key, type: b.type, all: b.all, then: b.then, else: b.else };
      case "approval":
        return {
          kind: "approval",
          key: b.key,
          type: b.type,
          role: b.role,
          deadlineMs: msOf(b.deadline),
          editable: b.editable,
          reviews: b.draft === undefined ? "nothing" : "draft",
          draft: b.draft ?? null,
          next: b.next,
        };
      case "wait":
        return { kind: "wait", key: b.key, type: b.type, durationMs: msOf(b.duration), next: b.next };
      case "end":
        return { kind: "end", key: b.key, type: b.type, status: b.status };
      case "docs.issue-draft":
      case "docs.issue-create":
        return {
          kind: "action",
          key: b.key,
          type: b.type,
          ...DOCS_NODES[b.type],
          timeoutMs: msOf(b.timeout),
          approval: b.type === "docs.issue-create" ? b.approval : null,
          next: b.next,
        };
    }
  });
}
