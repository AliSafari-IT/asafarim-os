/**
 * The draft's graph as written (valid or not): its edges, and which nodes come before a node on every
 * path from the start (its dominators), the same rule validation applies to what a node may read
 * (lib/workflow/definition-v2.ts). Pure: the builder runs it in the browser.
 */
import { EDGE_FIELDS, type Draft, type EdgeField, type RawNode } from "./types";

export const keyOf = (n: RawNode): string | undefined => (typeof n.key === "string" ? n.key : undefined);

/** The edges a node has: each field set to a string. */
export function edgesOf(n: RawNode): { field: EdgeField; to: string }[] {
  return EDGE_FIELDS.flatMap((field) => (typeof n[field] === "string" ? [{ field, to: n[field] as string }] : []));
}

/**
 * For each node reachable from the start, the nodes upstream of it on every path; nothing for a graph
 * with a cycle or without a start (validation reports those).
 */
export function upstreamOf(draft: Draft): Map<string, Set<string>> {
  const byKey = new Map<string, RawNode>();
  for (const n of draft.nodes) {
    const k = keyOf(n);
    if (k !== undefined && !byKey.has(k)) byKey.set(k, n);
  }
  const out = new Map<string, Set<string>>();
  if (!byKey.has(draft.start)) return out;
  const succ = (k: string) => edgesOf(byKey.get(k)!).filter((e) => byKey.has(e.to));
  // Reverse postorder from the start; a back edge means a cycle.
  const state = new Map<string, "open" | "done">();
  const order: string[] = [];
  let cyclic = false;
  const visit = (k: string) => {
    state.set(k, "open");
    for (const e of succ(k)) {
      const s = state.get(e.to);
      if (s === "open") cyclic = true;
      else if (s === undefined) visit(e.to);
    }
    state.set(k, "done");
    order.unshift(k);
  };
  visit(draft.start);
  if (cyclic) return out;
  const preds = new Map<string, string[]>();
  for (const k of order) for (const e of succ(k)) preds.set(e.to, [...(preds.get(e.to) ?? []), k]);
  for (const k of order) {
    let dom: Set<string> | undefined;
    for (const p of preds.get(k) ?? []) {
      const withP = new Set([...out.get(p)!, p]);
      dom = dom === undefined ? withP : new Set([...dom].filter((x) => withP.has(x)));
    }
    out.set(k, k === draft.start ? new Set() : (dom ?? new Set()));
  }
  return out;
}

/** The node keys in the order a run would first reach them (then the unreachable ones, as written). */
export function orderOf(draft: Draft): string[] {
  const byKey = new Map(draft.nodes.flatMap((n) => (keyOf(n) !== undefined ? [[keyOf(n)!, n] as const] : [])));
  const seen = new Set<string>();
  const queue = byKey.has(draft.start) ? [draft.start] : [];
  while (queue.length) {
    const k = queue.shift()!;
    if (seen.has(k)) continue;
    seen.add(k);
    for (const e of edgesOf(byKey.get(k)!)) if (byKey.has(e.to) && !seen.has(e.to)) queue.push(e.to);
  }
  return [...seen, ...[...byKey.keys()].filter((k) => !seen.has(k))];
}
