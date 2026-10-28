/**
 * The edits the builder makes, each a new draft from the old one (pure): add, connect, rename, change
 * and delete a node, set the trigger. The canvas, the node list and the settings panel all go through
 * these, so a keyboard edit and a drag make the same definition. Nodes are named by their canvas id
 * (lib/builder/canvas.ts `nodeIds`): their key, or `#<index>` for one without a usable key.
 */
import { KEY } from "../workflow/schema";
import { nodeIds, TRIGGER_ID, type Position } from "./canvas";
import { defaultOf } from "./defaults";
import { edgesOf, keyOf } from "./graph";
import {
  EDGE_FIELDS,
  type CredentialRef,
  type Draft,
  type EdgeField,
  type NodeSpec,
  type RawNode,
  type TriggerSpec,
} from "./types";

export const KEY_MAX = 40;
export const isNodeKey = (k: string) => k.length <= KEY_MAX && KEY.test(k);

/** What a built-in node starts with where its schema has no default. */
const STARTERS: Record<string, Record<string, unknown>> = {
  approval: { role: "flow.approver", deadline: "P7D" },
  wait: { duration: "PT1H" },
};

const indexOf = (draft: Draft, id: string) => nodeIds(draft).indexOf(id);

/** A key for a node of `type` that no node has: `email-send`, then `email-send-2`, … */
export function newKey(draft: Draft, type: string): string {
  const base =
    type
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^(\d)/, "n$1")
      .slice(0, KEY_MAX - 3) || "node";
  const taken = new Set(draft.nodes.map(keyOf));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** A new node of `spec`'s type with the defaults of its settings (the first credential of each kind). */
export function newNode(draft: Draft, spec: NodeSpec, credentials: readonly CredentialRef[] = []): RawNode {
  const settings = defaultOf(spec.settings) as Record<string, unknown>;
  for (const [k, p] of Object.entries(spec.settings.properties ?? {})) {
    const kind = p["x-credential"];
    if (kind && settings[k] === "") settings[k] = credentials.find((c) => c.kind === kind)?.id ?? "";
  }
  const key = newKey(draft, spec.type);
  return spec.connector
    ? { key, type: spec.type, input: settings }
    : { key, type: spec.type, ...settings, ...STARTERS[spec.type] };
}

/**
 * Add `node`. After `after` (a node or the trigger), it takes that one's place in the graph: the
 * edge that left `after` by `next` (a condition's `then`, the trigger's `start`) now goes to the new
 * node, and the new node goes on to where it went. Without `after`, it is added unconnected.
 */
export function addNode(draft: Draft, node: RawNode, spec: NodeSpec, after?: string, position?: Position): Draft {
  const key = node.key as string;
  const added: RawNode = { ...node };
  let nodes = [...draft.nodes];
  let start = draft.start;
  const link = (target: string | undefined) => {
    if (!target) return;
    for (const f of spec.edges) added[f] = target;
  };
  if (after === TRIGGER_ID) {
    link(start || undefined);
    start = key;
  } else if (after !== undefined) {
    const i = indexOf(draft, after);
    const prev = nodes[i];
    if (prev && "next" in prev && typeof prev.next === "string") {
      link(prev.next);
      nodes[i] = { ...prev, next: key };
    } else if (prev && typeof prev.then === "string") {
      // After a condition: on its `then` branch.
      link(prev.then);
      nodes[i] = { ...prev, then: key };
    } else if (prev && !(["then", "else"] as const).some((f) => typeof prev[f] === "string") && prev.type !== "end") {
      nodes[i] = { ...prev, next: key };
    }
  }
  if (!draft.nodes.length && !start) start = key;
  nodes = [...nodes, added];
  const layout = position ? { ...draft.layout, [key]: position } : draft.layout;
  return { ...draft, start, nodes, ...(layout ? { layout } : {}) };
}

/** Set (or with "", remove) the edge `field` of `source` (`start` of the trigger). */
export function connect(draft: Draft, source: string, field: EdgeField | "start", target: string): Draft {
  if (source === TRIGGER_ID) return { ...draft, start: target };
  const i = indexOf(draft, source);
  if (i < 0 || field === "start") return draft;
  const node: RawNode = { ...draft.nodes[i]! };
  if (target) node[field] = target;
  else delete node[field];
  return { ...draft, nodes: draft.nodes.map((n, j) => (j === i ? node : n)) };
}

/** Replace node `id` with `node` (its settings changed; its key and edges as they were, unless changed). */
export function updateNode(draft: Draft, id: string, node: RawNode): Draft {
  const i = indexOf(draft, id);
  if (i < 0) return draft;
  return { ...draft, nodes: draft.nodes.map((n, j) => (j === i ? node : n)) };
}

/** Every string in `value` with `{{steps.<from>.output…}}` reading `<to>` instead. */
function renameReads(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string")
    return value.replace(
      new RegExp(`(\\{\\{\\s*steps\\.)${from.replace(/-/g, "\\-")}(\\.output[^}]*\\}\\})`, "g"),
      `$1${to}$2`,
    );
  if (Array.isArray(value)) return value.map((v) => renameReads(v, from, to));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameReads(v, from, to)]));
  return value;
}

/**
 * Rename node `from` to `to`: its edges in, the start, its layout, and what reads it (placeholders,
 * a condition's fields, an approval's draft, an issue's approval) follow. Unchanged when `to` isn't a
 * key or is taken.
 */
export function renameNode(draft: Draft, from: string, to: string): Draft {
  if (!isNodeKey(to) || draft.nodes.some((n) => keyOf(n) === to) || indexOf(draft, from) < 0) return draft;
  const nodes = draft.nodes.map((n) => {
    let m: RawNode = keyOf(n) === from ? { ...n, key: to } : { ...n };
    for (const f of EDGE_FIELDS) if (m[f] === from) m[f] = to;
    if (m.type === "approval" && m.draft === from) m.draft = to;
    if (m.type === "docs.issue-create" && m.approval === from) m.approval = to;
    if (m.type === "condition" && Array.isArray(m.all))
      m.all = m.all.map((c: unknown) => {
        const clause = c as Record<string, unknown>;
        const field = typeof clause?.field === "string" ? clause.field : undefined;
        return field?.startsWith(`steps.${from}.`)
          ? { ...clause, field: `steps.${to}.${field.slice(`steps.${from}.`.length)}` }
          : c;
      });
    m = renameReads(m, from, to) as RawNode;
    return m;
  });
  let layout = draft.layout;
  if (layout?.[from]) {
    const { [from]: at, ...rest } = layout;
    layout = { ...rest, [to]: at! };
  }
  return { ...draft, start: draft.start === from ? to : draft.start, nodes, ...(layout ? { layout } : {}) };
}

/**
 * Delete node `id`. The edges that went to it go where it went (its `next`; nowhere when it branched
 * or ended), so a node taken out of a chain leaves the chain joined. What read it is left: validation
 * reports it.
 */
export function deleteNode(draft: Draft, id: string): Draft {
  const i = indexOf(draft, id);
  if (i < 0) return draft;
  const gone = draft.nodes[i]!;
  const key = keyOf(gone);
  const edges = edgesOf(gone);
  const onward = edges.length === 1 && edges[0]!.field === "next" ? edges[0]!.to : undefined;
  const nodes = draft.nodes
    .filter((_, j) => j !== i)
    .map((n) => {
      if (key === undefined) return n;
      const m: RawNode = { ...n };
      for (const f of EDGE_FIELDS) {
        if (m[f] !== key) continue;
        if (onward !== undefined) m[f] = onward;
        else delete m[f];
      }
      return m;
    });
  const start = draft.start === key ? (onward ?? "") : draft.start;
  let layout = draft.layout;
  if (layout && id in layout) {
    const { [id]: _gone, ...rest } = layout;
    layout = rest;
  }
  return { ...draft, start, nodes, ...(layout ? { layout } : {}) };
}

/** The trigger as `trigger` (its settings changed). */
export const setTrigger = (draft: Draft, trigger: Record<string, unknown>): Draft => ({ ...draft, trigger });

/** A new trigger of `spec`'s type, with its defaults. */
export const newTrigger = (spec: TriggerSpec): Record<string, unknown> => ({
  type: spec.type,
  ...(defaultOf(spec.settings) as Record<string, unknown>),
});

/** A new workflow's first draft: the trigger, then an end. */
export function starterDraft(key: string, trigger: Record<string, unknown>): Draft {
  return { version: 2, key, trigger, start: "end", nodes: [{ key: "end", type: "end" }] };
}
