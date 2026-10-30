import { nodeIds, toCanvas } from "./canvas";
import { edgesOf, keyOf } from "./graph";
import type { Draft } from "./types";

export const WORKFLOW_DIAGRAM_NODE_WIDTH = 208;
export const WORKFLOW_DIAGRAM_NODE_HEIGHT = 68;
const MARGIN = 28;

export interface DiagramNode {
  id: string;
  title: string;
  type: string;
  x: number;
  y: number;
}

export interface DiagramEdge {
  source: string;
  target: string;
  label: string;
}

export interface WorkflowDiagram {
  width: number;
  height: number;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/** A settings-free chart suitable for download and printing. */
export function workflowDiagram(draft: Draft): WorkflowDiagram {
  const canvas = toCanvas(draft);
  const xs = canvas.nodes.map((node) => node.position.x);
  const ys = canvas.nodes.map((node) => node.position.y);
  const minX = Math.min(0, ...xs);
  const minY = Math.min(0, ...ys);
  const maxX = Math.max(0, ...xs);
  const maxY = Math.max(0, ...ys);
  const byId = new Map(canvas.nodes.map((node) => [node.id, node]));
  const nodes = canvas.nodes.map((node): DiagramNode => {
    const type =
      node.type === "trigger" ? String(draft.trigger.type ?? "trigger") : String(node.data.node?.type ?? "step");
    const title = node.type === "trigger" ? "Trigger" : (keyOf(node.data.node ?? {}) ?? "Unnamed step");
    return {
      id: node.id,
      title,
      type,
      x: node.position.x - minX + MARGIN,
      y: node.position.y - minY + MARGIN,
    };
  });
  const edges = canvas.edges.flatMap((edge) => {
    if (!byId.has(edge.source) || !byId.has(edge.target)) return [];
    return [
      {
        source: edge.source,
        target: edge.target,
        label: edge.sourceHandle === "start" ? "" : edge.sourceHandle,
      },
    ];
  });
  return {
    width: maxX - minX + WORKFLOW_DIAGRAM_NODE_WIDTH + MARGIN * 2,
    height: maxY - minY + WORKFLOW_DIAGRAM_NODE_HEIGHT + MARGIN * 2,
    nodes,
    edges,
  };
}

/** A numbered, branch-aware outline that avoids printing workflow settings or personal data. */
export function workflowOutline(draft: Draft): string[] {
  const keys = nodeIds(draft);
  const nodes = new Map(keys.map((id, index) => [id, draft.nodes[index]!]));
  const counts = new Map<string, number>();
  keys.forEach((id, index) => {
    const key = keyOf(draft.nodes[index]!);
    if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  const idForKey = new Map(
    keys.flatMap((id, index) => {
      const key = keyOf(draft.nodes[index]!);
      return key !== undefined && counts.get(key) === 1 ? [[key, id] as const] : [];
    }),
  );
  const nodeOrder: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (!nodes.has(id) || visited.has(id)) return;
    visited.add(id);
    nodeOrder.push(id);
    const node = nodes.get(id)!;
    const edges = edgesOf(node);
    for (const field of ["then", "else", "next"])
      for (const edge of edges) if (edge.field === field) visit(idForKey.get(edge.to) ?? edge.to);
  };
  visit(draft.start);
  for (const id of keys) visit(id);
  const numberOf = new Map(nodeOrder.map((id, index) => [id, index + 1]));
  const lines = [`Trigger: ${String(draft.trigger.type ?? "unknown")}`];
  for (const id of nodeOrder) {
    const node = nodes.get(id)!;
    const key = keyOf(node) ?? id;
    lines.push(`${numberOf.get(id)}. ${key} (${String(node.type ?? "unknown")})`);
    for (const edge of edgesOf(node)) {
      const targetId = idForKey.get(edge.to);
      const target = targetId ? numberOf.get(targetId) : undefined;
      lines.push(
        `   ${edge.field === "then" ? "Then" : edge.field === "else" ? "Else" : "Next"} → ${target ? `${target}. ${edge.to}` : "unconnected"}`,
      );
    }
  }
  return lines;
}
