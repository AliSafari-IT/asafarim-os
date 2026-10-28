/**
 * The draft definition as the canvas shows it, and back. The canvas is a view of the definition: its
 * nodes are the trigger and `nodes[]`, its edges `start` and each node's `next` / `then` / `else`, its
 * positions `layout` (or, for a node without one, a place worked out from the graph). Nothing on the
 * canvas exists only there: `fromCanvas(draft, toCanvas(draft))` is `draft`, and moving a node changes
 * `layout` and nothing else. Pure: no React Flow import, so it is tested on its own.
 */
import { edgesOf, keyOf } from "./graph";
import { EDGE_FIELDS, type Draft, type EdgeField, type RawNode } from "./types";

/** The trigger's id on the canvas and in `layout` (never a node key: those are kebab-case). */
export const TRIGGER_ID = "@trigger";
export const START_HANDLE = "start";

export interface Position {
  x: number;
  y: number;
}

export interface CanvasNode {
  id: string;
  type: "trigger" | "step";
  position: Position;
  /** The trigger, or the node as written. */
  data: { trigger?: Record<string, unknown>; node?: RawNode; index?: number };
  deletable: boolean;
}

export interface CanvasEdge {
  id: string;
  source: string;
  /** The field the edge is: `start` from the trigger, else `next`, `then` or `else`. */
  sourceHandle: EdgeField | typeof START_HANDLE;
  target: string;
}

export interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

const COLUMN = 240;
const ROW = 140;

/** Each node's id on the canvas: its key, or `#<index>` when it has none or shares it. */
export function nodeIds(draft: Draft): string[] {
  const counts = new Map<string, number>();
  for (const n of draft.nodes) {
    const k = keyOf(n);
    if (k !== undefined) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return draft.nodes.map((n, i) => {
    const k = keyOf(n);
    return k !== undefined && counts.get(k) === 1 && k !== TRIGGER_ID ? k : `#${i}`;
  });
}

/** A place for every node: in rows by its distance from the trigger, side by side within a row. */
export function autoPositions(draft: Draft): Map<string, Position> {
  const ids = nodeIds(draft);
  const idSet = new Set(ids);
  const depth = new Map<string, number>([[TRIGGER_ID, 0]]);
  const queue: string[] = [];
  if (idSet.has(draft.start)) {
    depth.set(draft.start, 1);
    queue.push(draft.start);
  }
  const byId = new Map(ids.map((id, i) => [id, draft.nodes[i]!]));
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of edgesOf(byId.get(id)!)) {
      if (idSet.has(e.to) && !depth.has(e.to)) {
        depth.set(e.to, depth.get(id)! + 1);
        queue.push(e.to);
      }
    }
  }
  // Unreachable nodes go in a row of their own, below the rest.
  const last = Math.max(0, ...depth.values()) + 1;
  for (const id of ids) if (!depth.has(id)) depth.set(id, last);
  const perRow = new Map<number, number>();
  const out = new Map<string, Position>();
  for (const id of [TRIGGER_ID, ...ids]) {
    const d = depth.get(id)!;
    const i = perRow.get(d) ?? 0;
    perRow.set(d, i + 1);
    out.set(id, { x: i * COLUMN, y: d * ROW });
  }
  return out;
}

export function toCanvas(draft: Draft): Canvas {
  const ids = nodeIds(draft);
  const auto = autoPositions(draft);
  const at = (id: string) => draft.layout?.[id] ?? auto.get(id)!;
  const nodes: CanvasNode[] = [
    { id: TRIGGER_ID, type: "trigger", position: at(TRIGGER_ID), data: { trigger: draft.trigger }, deletable: false },
    ...draft.nodes.map((node, index): CanvasNode => ({
      id: ids[index]!,
      type: "step",
      position: at(ids[index]!),
      data: { node, index },
      deletable: true,
    })),
  ];
  const idSet = new Set(ids);
  const edges: CanvasEdge[] = [];
  if (idSet.has(draft.start))
    edges.push({ id: `${TRIGGER_ID}:start`, source: TRIGGER_ID, sourceHandle: START_HANDLE, target: draft.start });
  draft.nodes.forEach((n, i) => {
    for (const e of edgesOf(n)) {
      if (idSet.has(e.to))
        edges.push({ id: `${ids[i]}:${e.field}`, source: ids[i]!, sourceHandle: e.field, target: e.to });
    }
  });
  return { nodes, edges };
}

const samePosition = (a: Position | undefined, b: Position | undefined) => a?.x === b?.x && a?.y === b?.y;

/**
 * The definition the canvas shows, on top of `base` (the draft it was made from). An edge field that
 * names a node the canvas doesn't have (a typo, a deleted node) isn't drawn, and is kept as written.
 * `layout` holds the positions `base` had and those that differ from the place worked out.
 */
export function fromCanvas(base: Draft, canvas: Canvas): Draft {
  const ids = new Set(canvas.nodes.map((n) => n.id));
  const steps = canvas.nodes.filter((n) => n.type === "step");
  const nodes = steps.map((c) => {
    const node: RawNode = { ...c.data.node };
    for (const field of EDGE_FIELDS)
      if (typeof node[field] === "string" && ids.has(node[field] as string)) delete node[field];
    for (const e of canvas.edges)
      if (e.source === c.id && e.sourceHandle !== START_HANDLE) node[e.sourceHandle] = e.target;
    // The fields in the order they were written.
    const original = c.data.node ?? {};
    return Object.fromEntries([
      ...Object.keys(original)
        .filter((k) => k in node)
        .map((k) => [k, node[k]]),
      ...Object.keys(node)
        .filter((k) => !(k in original))
        .map((k) => [k, node[k]]),
    ]) as RawNode;
  });
  const startEdge = canvas.edges.find((e) => e.source === TRIGGER_ID);
  const start = startEdge ? startEdge.target : ids.has(base.start) ? "" : base.start;
  const trigger = canvas.nodes.find((n) => n.type === "trigger")?.data.trigger ?? base.trigger;
  const next: Draft = { ...base, trigger, start, nodes };
  const auto = autoPositions(next);
  const layout: Record<string, Position> = {};
  for (const c of canvas.nodes) {
    if (base.layout?.[c.id] !== undefined || !samePosition(c.position, auto.get(c.id)))
      layout[c.id] = { x: c.position.x, y: c.position.y };
  }
  const { layout: _old, ...rest } = next;
  return base.layout !== undefined || Object.keys(layout).length ? { ...rest, layout } : (rest as Draft);
}

/** The draft with node `id` (or the trigger) at `position`: only `layout` changes. */
export function moveNode(draft: Draft, id: string, position: Position): Draft {
  return { ...draft, layout: { ...draft.layout, [id]: { x: Math.round(position.x), y: Math.round(position.y) } } };
}

/**
 * What a delete on the canvas does to the draft, for React Flow's `onDelete` (it passes a deleted
 * node's edges with it): the nodes to delete, and the edges to remove on their own, leaving out those
 * that touch a deleted node, so `deleteNode` can still join the chain around it.
 */
export function deletion(
  nodes: readonly { id: string }[],
  edges: readonly { source: string; sourceHandle?: string | null; target: string }[],
): { nodes: string[]; edges: { source: string; field: EdgeField | typeof START_HANDLE }[] } {
  const gone = new Set(nodes.map((n) => n.id).filter((id) => id !== TRIGGER_ID));
  return {
    nodes: [...gone],
    edges: edges
      .filter((e) => !gone.has(e.source) && !gone.has(e.target))
      .map((e) => ({ source: e.source, field: (e.sourceHandle ?? "next") as EdgeField | typeof START_HANDLE })),
  };
}
