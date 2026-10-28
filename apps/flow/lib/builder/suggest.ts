/**
 * What a `{{…}}` field (or a condition's field) may read, for its autocomplete: the trigger's example
 * payload, and the output of the steps upstream of the node on every path (from the output schemas in
 * the catalog). A step after the node, beside it on another branch, or the node itself is never
 * offered: validation would refuse it. Also the test run's example trigger data. Pure.
 */
import { resolve } from "./defaults";
import { keyOf, upstreamOf } from "./graph";
import type { Catalog, Draft, JsonSchema, RawNode } from "./types";

export interface Suggestion {
  /** `trigger.title`, `steps.send.output.messageId`. */
  path: string;
  /** Where it comes from: "trigger", or the step's type. */
  from: string;
}

const FIELD = /^[A-Za-z0-9_-]+$/;
const READ = /(?:trigger(?:\.[A-Za-z0-9_-]+)+)/g;

/** The `trigger.…` paths the draft reads already: in placeholders and in conditions' fields. */
function triggerReads(draft: Draft): string[] {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") for (const m of v.matchAll(READ)) found.add(m[0]);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  draft.nodes.forEach(walk);
  return [...found].sort();
}

/** Segments that would reach an object's prototype instead of a field of its own. */
const UNSAFE = new Set(["__proto__", "prototype", "constructor"]);

/**
 * `value` at `parts` in `target`, unless something is there already. A path read from a draft (any
 * JSON, not checked yet): a segment that would reach a prototype makes it skipped, and only own
 * properties are walked, so a draft can't write to Object.prototype in the editor's page.
 */
function set(target: Record<string, unknown>, parts: string[], value: unknown) {
  if (!parts.length || parts.some((p) => UNSAFE.has(p))) return;
  let at = target;
  for (const p of parts.slice(0, -1)) {
    const next = Object.hasOwn(at, p) ? at[p] : undefined;
    if (typeof next !== "object" || next === null || Array.isArray(next)) at[p] = {};
    at = at[p] as Record<string, unknown>;
  }
  const last = parts.at(-1)!;
  if (!Object.hasOwn(at, last)) at[last] = value;
}

/**
 * An example of what the trigger delivers, for the test run's form and the suggestions: the input
 * fields of a manual or webhook trigger, a GitHub delivery's usual fields, and every trigger field the
 * draft reads already.
 */
export function triggerExample(draft: Draft): Record<string, unknown> {
  const t = draft.trigger;
  const out: Record<string, unknown> = {};
  if ((t.type === "manual" || t.type === "webhook") && Array.isArray(t.input)) {
    for (const f of t.input as { name?: unknown; type?: unknown }[]) {
      if (typeof f?.name !== "string" || UNSAFE.has(f.name)) continue;
      out[f.name] = f.type === "number" ? 1 : f.type === "boolean" ? true : `example ${f.name}`;
    }
  }
  if (t.type === "github") {
    const repos = Array.isArray(t.repos) ? t.repos : typeof t.repo === "string" ? [t.repo] : [];
    const repo = typeof repos[0] === "string" ? repos[0] : "owner/name";
    Object.assign(out, {
      action: "opened",
      repository: { full_name: repo },
      issue: {
        number: 1,
        title: "An example issue",
        body: "",
        html_url: `https://github.com/${repo}/issues/1`,
        labels: [{ name: "bug" }],
      },
      labels: ["bug"],
      sender: { login: "octocat" },
    });
  }
  for (const path of triggerReads(draft)) set(out, path.split(".").slice(1), "");
  return out;
}

/** The paths into `value`: each object's fields, to `depth` levels. */
function valuePaths(value: unknown, prefix: string, depth: number): string[] {
  if (depth === 0 || !value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([k, v]) =>
    FIELD.test(k) ? [`${prefix}.${k}`, ...valuePaths(v, `${prefix}.${k}`, depth - 1)] : [],
  );
}

/** The paths into what `schema` describes: its properties, to `depth` levels. */
function schemaPaths(schema: JsonSchema, prefix: string, depth: number, defs = schema.$defs): string[] {
  const s = resolve(schema, defs);
  if (depth === 0 || s.type !== "object") return [];
  return Object.entries(s.properties ?? {}).flatMap(([k, p]) =>
    FIELD.test(k) ? [`${prefix}.${k}`, ...schemaPaths(p, `${prefix}.${k}`, depth - 1, defs)] : [],
  );
}

/** What node `key` may read: the trigger's fields, then the outputs of the steps upstream of it. */
export function suggestionsFor(draft: Draft, key: string | undefined, catalog: Catalog): Suggestion[] {
  const out: Suggestion[] = valuePaths(triggerExample(draft), "trigger", 3).map((path) => ({ path, from: "trigger" }));
  const upstream = key === undefined ? undefined : upstreamOf(draft).get(key);
  if (!upstream) return out;
  const byKey = new Map(draft.nodes.map((n) => [keyOf(n), n] as [string | undefined, RawNode]));
  for (const k of upstream) {
    const type = byKey.get(k)?.type;
    const spec = catalog.nodes.find((s) => s.type === type);
    if (!spec?.output) continue;
    const prefix = `steps.${k}.output`;
    out.push(
      { path: prefix, from: spec.type },
      ...schemaPaths(spec.output, prefix, 2).map((path) => ({ path, from: spec.type })),
    );
  }
  return out;
}

/** The suggestions that fit what was typed after `{{` (or into a condition's field). */
export function matching(suggestions: readonly Suggestion[], typed: string, limit = 20): Suggestion[] {
  const t = typed.trim().toLowerCase();
  return suggestions.filter((s) => s.path.toLowerCase().includes(t)).slice(0, limit);
}
