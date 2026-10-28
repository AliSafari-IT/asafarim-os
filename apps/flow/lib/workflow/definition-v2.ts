/**
 * The workflow definition, version 2 (Flow ADR 0002): a graph of nodes, what the builder edits and the
 * engine runs. Version 1 (lib/workflow/definition.ts) stays valid next to it.
 *
 *   { version: 2, key, trigger, start: <node key>, nodes: [{ key, type, …, next | then + else }], layout }
 *
 * Triggers: `event` (an OS app event type, as v1), `manual` (`input`: the fields a person fills in),
 * `webhook` and `github` (their entry points come with PR 2.4). Nodes:
 *
 * - **condition** `{ all, then, else }`: every clause holds → `then`, otherwise `else` (clauses as v1).
 * - **approval** `{ role, deadline, onExpire, draft?, editable, next }`: as v1. With `draft` (a
 *   `docs.issue-draft` node) the approver reviews and may edit that draft; without it, a plain decision.
 * - **wait** `{ duration, next }`: an ISO 8601 duration, at most 30 days.
 * - **docs.issue-draft** `{ timeout, next }` and **docs.issue-create** `{ approval, timeout, next }`: the
 *   slice-1 Docs actions (flow.issue-draft.requested.v1 / flow.issue.approved.v1 and their outcomes).
 * - **end** `{ status? }`: the run ends `succeeded` (or `skipped`).
 * - **a connector** `{ type: "<app>.<action>", input, next }`: a registered connector
 *   (lib/engine/connectors.ts); `input` fits its schema, and its templated fields may hold placeholders
 *   (lib/workflow/templates.ts).
 *
 * The graph is acyclic, every node is reachable from `start` and every path ends at an `end`, with at
 * most 50 nodes whose keys are unique and kebab-case. A node may only read (a condition's field, a
 * placeholder, an approval's draft, an issue's approval) a node that is upstream of it on EVERY path.
 * `layout` is the builder's and the engine ignores it. Validation returns every problem, each with the
 * key of the node it is about.
 */
import { z } from "zod";
import { connectors as registry, type ConnectorRegistry } from "../engine/connectors";
import { stepKeyOf } from "./context";
import { durationMs } from "./duration";
import { Clause, duration, editableFields, eventType, KEY, ROLE, stepKey, workflowKey, type Problem } from "./schema";
import { placeholdersIn, walkStrings } from "./templates";

export const MAX_NODES = 50;
export const MAX_WAIT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** owner/name, as GitHub allows it. */
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
/** A connector's node type, `<app>.<action>`. */
export const CONNECTOR_TYPE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

export const InputField = z.strictObject({
  name: z
    .string()
    .max(40)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "must be a letter, then letters, digits or _"),
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean().default(false),
  label: z.string().min(1).max(80).optional(),
});
export type InputField = z.infer<typeof InputField>;

const inputFields = z
  .array(InputField)
  .max(20)
  .default([])
  .refine((fields) => new Set(fields.map((f) => f.name)).size === fields.length, "field names must be distinct");

export const TriggerV2 = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("event"), event: eventType }),
  z.strictObject({ type: z.literal("manual"), input: inputFields }),
  /** The JSON body's fields the workflow reads (PR 2.4 receives and checks the request). */
  z.strictObject({ type: z.literal("webhook"), input: inputFields }),
  /** GitHub webhook deliveries for one repository (PR 2.4): `issues.opened`, `push`, … */
  z.strictObject({
    type: z.literal("github"),
    repo: z.string().regex(REPO, "must be owner/name"),
    events: z
      .array(z.string().regex(/^[a-z_]+(?:\.[a-z_]+)?$/, "must be a GitHub event, optionally .<action>"))
      .min(1)
      .max(10),
  }),
]);
export type TriggerV2 = z.infer<typeof TriggerV2>;
export type TriggerType = TriggerV2["type"];

const next = stepKey;

const ConditionNode = z.strictObject({
  key: stepKey,
  type: z.literal("condition"),
  all: z.array(Clause).min(1).max(20),
  then: next,
  else: next,
});
const ApprovalNode = z.strictObject({
  key: stepKey,
  type: z.literal("approval"),
  role: z.string().regex(ROLE, "must be a role key"),
  deadline: duration,
  onExpire: z.literal("stop"),
  /** The docs.issue-draft node whose draft the approver reviews; none: a plain approve or reject. */
  draft: stepKey.optional(),
  editable: editableFields.default([]),
  next,
});
const WaitNode = z.strictObject({
  key: stepKey,
  type: z.literal("wait"),
  duration: duration.refine(
    (d) => (durationMs(d) ?? 0) <= MAX_WAIT_DAYS * DAY_MS,
    `must be at most ${MAX_WAIT_DAYS} days`,
  ),
  next,
});
const EndNode = z.strictObject({
  key: stepKey,
  type: z.literal("end"),
  status: z.enum(["succeeded", "skipped"]).default("succeeded"),
});
const IssueDraftNode = z.strictObject({
  key: stepKey,
  type: z.literal("docs.issue-draft"),
  timeout: duration.default("PT5M"),
  next,
});
const IssueCreateNode = z.strictObject({
  key: stepKey,
  type: z.literal("docs.issue-create"),
  /** The approval node whose decision is the issue (it reviews a draft). */
  approval: stepKey,
  timeout: duration.default("PT5M"),
  next,
});
const ConnectorNode = z.strictObject({
  key: stepKey,
  type: z
    .string()
    .regex(CONNECTOR_TYPE, "must be a node type")
    .refine((t) => !BUILTIN_TYPES.includes(t as BuiltinType), "is a built-in node type"),
  input: z.record(z.string(), z.unknown()).default({}),
  next,
});

const BUILTIN = {
  condition: ConditionNode,
  approval: ApprovalNode,
  wait: WaitNode,
  end: EndNode,
  "docs.issue-draft": IssueDraftNode,
  "docs.issue-create": IssueCreateNode,
} as const;
export type BuiltinType = keyof typeof BUILTIN;
export const BUILTIN_TYPES = Object.keys(BUILTIN) as BuiltinType[];

export type ConditionNode = z.infer<typeof ConditionNode>;
export type ApprovalNode = z.infer<typeof ApprovalNode>;
export type WaitNode = z.infer<typeof WaitNode>;
export type EndNode = z.infer<typeof EndNode>;
export type IssueDraftNode = z.infer<typeof IssueDraftNode>;
export type IssueCreateNode = z.infer<typeof IssueCreateNode>;
export type ConnectorNode = z.infer<typeof ConnectorNode>;
export type BuiltinNode = ConditionNode | ApprovalNode | WaitNode | EndNode | IssueDraftNode | IssueCreateNode;
export type NodeV2 = BuiltinNode | ConnectorNode;

export const isConnectorNode = (n: NodeV2): n is ConnectorNode => !Object.hasOwn(BUILTIN, n.type);
/** The node as the built-in type it is, or undefined for a connector node. */
export const builtin = (n: NodeV2): BuiltinNode | undefined => (isConnectorNode(n) ? undefined : (n as BuiltinNode));

const Layout = z.record(z.string(), z.strictObject({ x: z.number().finite(), y: z.number().finite() }));

const Shape = z.strictObject({
  version: z.literal(2),
  key: workflowKey,
  trigger: TriggerV2,
  start: stepKey,
  nodes: z.array(z.unknown()).min(1),
  layout: Layout.optional(),
});

export interface WorkflowDefinitionV2 {
  version: 2;
  key: string;
  trigger: TriggerV2;
  start: string;
  nodes: NodeV2[];
  layout?: z.infer<typeof Layout>;
}

export interface ValidateOptions {
  /**
   * The connectors a node may use, checked with their input schemas: the process's registry by
   * default. `false` for a stored version, which stays readable if a connector it uses is gone (its
   * step fails `unknown_connector` instead).
   */
  connectors?: ConnectorRegistry | false;
}

export type V2Result = { ok: true; definition: WorkflowDefinitionV2 } | { ok: false; problems: Problem[] };

const pathOf = (path: readonly PropertyKey[]) => path.map(String).join(".");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The edges a node has, read from what was written even when the node itself doesn't validate. */
function edgesOf(raw: Record<string, unknown>): { field: string; to: string }[] {
  return (["next", "then", "else"] as const).flatMap((field) =>
    typeof raw[field] === "string" ? [{ field, to: raw[field] as string }] : [],
  );
}

/** Validate a v2 definition: every problem found, or the parsed definition. */
export function validateV2(value: unknown, opts: ValidateOptions = {}): V2Result {
  const connectors = opts.connectors === undefined ? registry : opts.connectors;
  const problems: Problem[] = [];
  const add = (node: string | undefined, path: string, message: string) =>
    problems.push({ ...(node !== undefined ? { node } : {}), path, message });

  const shape = Shape.safeParse(value);
  if (!shape.success) {
    for (const i of shape.error.issues) add(undefined, pathOf(i.path), i.message);
  }
  const raw = isRecord(value) ? value : {};
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  if (rawNodes.length > MAX_NODES) add(undefined, "nodes", `has ${rawNodes.length} nodes, at most ${MAX_NODES}`);
  const trigger = TriggerV2.safeParse(raw.trigger);

  // Each node on its own, so one bad node doesn't hide the problems of the others.
  const nodes: NodeV2[] = [];
  const rawByKey = new Map<string, Record<string, unknown>>();
  /** Every `{{…}}` path read in a templated field, by node. */
  const placeholders = new Map<string, { path: string; at: string }[]>();
  rawNodes.forEach((rawNode, i) => {
    if (!isRecord(rawNode)) return add(`#${i}`, "", "must be an object");
    const key = typeof rawNode.key === "string" && KEY.test(rawNode.key) ? rawNode.key : undefined;
    const who = key ?? `#${i}`;
    if (key !== undefined) {
      if (rawByKey.has(key)) add(key, "key", "duplicate node key");
      else rawByKey.set(key, rawNode);
    }
    const type = typeof rawNode.type === "string" ? rawNode.type : "";
    const schema = Object.hasOwn(BUILTIN, type) ? BUILTIN[type as BuiltinType] : ConnectorNode;
    const parsed = schema.safeParse(rawNode);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) add(who, pathOf(issue.path), issue.message);
    }

    let reads: { path: string; at: string }[] = [];
    if (schema === ConnectorNode && typeof rawNode.type === "string" && connectors) {
      const connector = connectors.get(rawNode.type);
      if (!connector) {
        if (CONNECTOR_TYPE.test(rawNode.type)) add(who, "type", `no connector ${rawNode.type}`);
      } else {
        const input = rawNode.input ?? {};
        const checked = connector.input.safeParse(input);
        if (!checked.success) {
          for (const issue of checked.error.issues) add(who, pathOf(["input", ...issue.path]), issue.message);
        }
        walkStrings(connector.input, input, (path, text, isTemplated) => {
          const at = pathOf(["input", ...path]);
          if (!text.includes("{{")) return;
          if (!isTemplated) return void add(who, at, "doesn't take placeholders");
          const found = placeholdersIn(text);
          for (const p of found.problems) add(who, at, p);
          reads = [...reads, ...found.paths.map((path) => ({ path, at }))];
        });
      }
    } else if (schema !== ConnectorNode) {
      // Built-in nodes have no templated field.
      walkStrings(undefined, rawNode, (path, text) => {
        if (text.includes("{{")) add(who, pathOf(path), "doesn't take placeholders");
      });
    }
    if (key !== undefined) placeholders.set(key, reads);
    if (parsed.success) nodes.push(parsed.data as NodeV2);
  });

  // The graph, from what was written: edges, the start, cycles, reachability, ends.
  const keys = [...rawByKey.keys()];
  const edges = new Map(keys.map((k) => [k, edgesOf(rawByKey.get(k)!).filter((e) => rawByKey.has(e.to))]));
  for (const k of keys) {
    for (const e of edgesOf(rawByKey.get(k)!)) {
      if (!rawByKey.has(e.to)) add(k, e.field, `goes to "${e.to}", which isn't a node`);
    }
  }
  const start = typeof raw.start === "string" ? raw.start : undefined;
  if (start !== undefined && rawNodes.length && !rawByKey.has(start))
    add(undefined, "start", `"${start}" isn't a node`);

  // Cycles: a depth-first search; each back edge is reported on the node it leaves.
  const state = new Map<string, "open" | "done">();
  const order: string[] = []; // reverse postorder: a topological order of an acyclic graph
  let cyclic = false;
  const visit = (k: string) => {
    state.set(k, "open");
    for (const e of edges.get(k)!) {
      const s = state.get(e.to);
      if (s === "open") {
        cyclic = true;
        add(k, e.field, `goes back to "${e.to}": the graph must not have a cycle`);
      } else if (s === undefined) visit(e.to);
    }
    state.set(k, "done");
    order.unshift(k);
  };
  const hasStart = start !== undefined && rawByKey.has(start);
  if (hasStart) visit(start);
  const reachable = new Set(state.keys());
  for (const k of keys) {
    if (reachable.has(k)) continue;
    // Without a start there is no telling what is reachable: only cycles are looked for.
    if (hasStart) add(k, "", `isn't reachable from "${start}"`);
    if (!state.has(k)) visit(k);
  }
  for (const k of reachable) {
    const r = rawByKey.get(k)!;
    if (r.type !== "end" && edges.get(k)!.length === 0 && edgesOf(r).length === 0) {
      add(k, "", "a path ends here: only an end node may have no next node");
    }
  }

  // Dominators (who is upstream on every path), over the reachable part of an acyclic graph.
  const upstream = new Map<string, Set<string>>();
  if (!cyclic && hasStart) {
    const preds = new Map<string, string[]>();
    for (const k of reachable) for (const e of edges.get(k)!) preds.set(e.to, [...(preds.get(e.to) ?? []), k]);
    for (const k of order) {
      if (!reachable.has(k)) continue;
      const ps = (preds.get(k) ?? []).filter((p) => reachable.has(p));
      let dom: Set<string> | undefined;
      for (const p of ps) {
        const withP = new Set([...upstream.get(p)!, p]);
        dom = dom === undefined ? withP : new Set([...dom].filter((x) => withP.has(x)));
      }
      upstream.set(k, k === start ? new Set() : (dom ?? new Set()));
    }
  }

  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const triggerFields =
    trigger.success && (trigger.data.type === "manual" || trigger.data.type === "webhook")
      ? new Set(trigger.data.input.map((f) => f.name))
      : undefined;
  /** `path` (a field path) read by `node` at `at`: a trigger field it has, a node upstream on every path. */
  const checkRead = (node: string, path: string, at: string) => {
    const read = stepKeyOf(path);
    if (read === undefined) {
      const field = path.split(".")[1];
      if (triggerFields && field !== undefined && !triggerFields.has(field)) {
        add(node, at, `reads trigger.${field}, which the trigger's input doesn't have`);
      }
      return;
    }
    if (!rawByKey.has(read)) return add(node, at, `reads "${read}", which isn't a node`);
    const up = upstream.get(node);
    if (up && !up.has(read)) add(node, at, `reads "${read}", which isn't upstream of this node on every path`);
  };
  const checkRef = (node: string, at: string, ref: string, type: string, what: string) => {
    const target = byKey.get(ref);
    if (!rawByKey.has(ref)) return add(node, at, `"${ref}" isn't a node`);
    if (target && target.type !== type) return add(node, at, `"${ref}" must be a ${type} node`);
    const up = upstream.get(node);
    if (up && !up.has(ref)) add(node, at, `${what} "${ref}" isn't upstream of this node on every path`);
  };
  for (const n of nodes) {
    if (!reachable.has(n.key)) continue;
    for (const { path, at } of placeholders.get(n.key) ?? []) checkRead(n.key, path, at);
    const b = builtin(n);
    if (b?.type === "condition") b.all.forEach((c, j) => checkRead(n.key, c.field, `all.${j}.field`));
    if (b?.type === "approval") {
      if (b.draft !== undefined) checkRef(n.key, "draft", b.draft, "docs.issue-draft", "the draft");
      else if (b.editable.length) add(n.key, "editable", "needs a draft to edit");
    }
    if (b?.type === "docs.issue-create") {
      checkRef(n.key, "approval", b.approval, "approval", "the approval");
      const approval = byKey.get(b.approval);
      if (approval?.type === "approval" && (approval as ApprovalNode).draft === undefined) {
        add(n.key, "approval", `"${b.approval}" doesn't review a draft`);
      }
    }
  }

  if (problems.length) return { ok: false, problems };
  const d = shape.data!;
  return {
    ok: true,
    definition: {
      version: 2,
      key: d.key,
      trigger: d.trigger,
      start: d.start,
      nodes,
      ...(d.layout ? { layout: d.layout } : {}),
    },
  };
}

/** The problems of a trigger's `data` against its input fields: a required one missing, a wrong type, an unknown field. */
export function inputProblems(fields: readonly InputField[], data: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const known = new Set(fields.map((f) => f.name));
  for (const name of Object.keys(data)) if (!known.has(name)) problems.push(`${name}: isn't an input field`);
  for (const f of fields) {
    const v = data[f.name];
    if (v === undefined || v === null || v === "") {
      if (f.required) problems.push(`${f.name}: is required`);
      continue;
    }
    const ok = f.type === "number" ? typeof v === "number" && Number.isFinite(v) : typeof v === f.type;
    if (!ok) problems.push(`${f.name}: must be a ${f.type}`);
  }
  return problems;
}
