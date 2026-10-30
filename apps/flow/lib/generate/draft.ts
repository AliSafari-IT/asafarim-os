/**
 * What the AI may answer when it drafts a workflow from an issue (#283), and how an answer becomes a
 * draft. The AI proposes; this decides what reaches the builder:
 *
 * 1. The answer must fit `GeneratedAnswer`: known node types only (the built-ins condition, approval,
 *    wait and end, and the registered connectors), at most 50 nodes, short notes.
 * 2. Whatever the AI wrote there, the server sets:
 *    - every connector node's `input` to `{}`: each connector sends something out (email, a webhook, a
 *      GitHub write), so none arrives with a URL, a recipient, a repository or a credential from the
 *      issue text. The person fills them in; the egress and email allow-lists still apply;
 *    - the trigger to `manual` (its input fields only); the AI's suggested trigger is a note;
 *    - an approval's role to `flow.approver`, its expiry to `stop`, nothing editable;
 *    - the workflow key (the caller's).
 * 3. The draft must pass `parseDefinition` (structure: keys, edges, one start, every path ending at an
 *    end, no cycle), without the connectors' input schemas: their inputs are empty on purpose and the
 *    builder lists them as problems until they are filled in.
 * 4. `assertNoConfiguredOutbound` checks step 2 once more, on the final draft.
 *
 * The draft is only ever saved as a draft: nothing here publishes, activates or runs it.
 */
import { z } from "zod";
import type { Draft, RawNode } from "../builder/types";
import { parseDefinition } from "../workflow/definition";
import { BUILTIN_TYPES, MAX_NODES } from "../workflow/definition-v2";
import { Clause, stepKey } from "../workflow/schema";

/** The built-in node types a generated draft may use (the Docs actions need a Docs setup: not offered). */
export const GENERATED_BUILTIN_TYPES = ["condition", "approval", "wait", "end"] as const;
/** The role every generated approval is given; the person changes it if another should decide. */
export const GENERATED_APPROVAL_ROLE = "flow.approver";
export const DEFAULT_APPROVAL_DEADLINE = "P7D";
export const MAX_NOTE_LENGTH = 280;

const note = z.string().trim().max(MAX_NOTE_LENGTH);
const nullableKey = stepKey.nullable();

const InputFieldAnswer = z.strictObject({
  name: z
    .string()
    .max(40)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  type: z.enum(["string", "number", "boolean"]),
  label: z.string().trim().max(80),
});

/** The answer's shape for a given set of connector types (what `answerJsonSchema` describes). */
export function generatedAnswer(connectorTypes: readonly string[]) {
  const types = [...GENERATED_BUILTIN_TYPES, ...connectorTypes] as [string, ...string[]];
  const Node = z.strictObject({
    key: stepKey,
    type: z.enum(types),
    note,
    next: nullableKey,
    then: nullableKey,
    else: nullableKey,
    clauses: z.array(Clause).max(20),
    deadline: z.string().max(40).nullable(),
    duration: z.string().max(40).nullable(),
    end_status: z.enum(["succeeded", "skipped"]).nullable(),
  });
  return z.strictObject({
    name: z.string().trim().min(1).max(80),
    summary: z.string().trim().max(600),
    trigger_note: note,
    inputs: z.array(InputFieldAnswer).max(20),
    start: stepKey,
    nodes: z.array(Node).min(1).max(MAX_NODES),
  });
}
export type GeneratedAnswer = z.infer<ReturnType<typeof generatedAnswer>>;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });

/**
 * The JSON Schema the AI's answer is constrained to (structured outputs). It holds no length or number
 * limits (the API doesn't take them): `generatedAnswer` checks those on the answer.
 */
export function answerJsonSchema(connectorTypes: readonly string[]): Record<string, unknown> {
  const str = { type: "string" };
  const clause = {
    type: "object",
    additionalProperties: false,
    required: ["field", "op", "value"],
    properties: {
      field: { type: "string", description: "trigger.<input name> or steps.<node key>.output.<field>" },
      op: { type: "string", enum: ["equals", "notEquals", "contains"] },
      value: { anyOf: [str, { type: "number" }, { type: "boolean" }, { type: "null" }] },
    },
  };
  const node = {
    type: "object",
    additionalProperties: false,
    required: ["key", "type", "note", "next", "then", "else", "clauses", "deadline", "duration", "end_status"],
    properties: {
      key: { type: "string", description: "kebab-case, unique, at most 40 characters" },
      type: { type: "string", enum: [...GENERATED_BUILTIN_TYPES, ...connectorTypes] },
      note: { type: "string", description: "One sentence: why this node is here, from the issue" },
      next: nullable({ type: "string", description: "The next node's key; null on condition and end" }),
      then: nullable({ type: "string", description: "condition only: the key when every clause holds" }),
      else: nullable({ type: "string", description: "condition only: the key otherwise" }),
      clauses: { type: "array", items: clause, description: "condition only (at least one); [] otherwise" },
      deadline: nullable({ type: "string", description: "approval only: an ISO 8601 duration such as P3D" }),
      duration: nullable({ type: "string", description: "wait only: an ISO 8601 duration, at most P30D" }),
      end_status: nullable({ type: "string", enum: ["succeeded", "skipped"] }),
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["name", "summary", "trigger_note", "inputs", "start", "nodes"],
    properties: {
      name: { type: "string", description: "A short name for the workflow" },
      summary: { type: "string", description: "Two sentences: what the workflow does" },
      trigger_note: { type: "string", description: "What should start it, in words (a person sets it up)" },
      inputs: {
        type: "array",
        description: "Fields a person fills in when starting it by hand; conditions read them as trigger.<name>",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "type", "label"],
          properties: {
            name: { type: "string", description: "A letter, then letters, digits or _" },
            type: { type: "string", enum: ["string", "number", "boolean"] },
            label: str,
          },
        },
      },
      start: { type: "string", description: "The key of the first node" },
      nodes: { type: "array", items: node, description: `At most ${MAX_NODES} nodes; every path ends at an end node` },
    },
  };
}

export interface GeneratedDraft {
  definition: Draft;
  /** Why each node is there, by node key (the AI's words; shown to the person, never audited). */
  notes: Record<string, string>;
  name: string;
  summary: string;
  triggerNote: string;
}

export type ToDraftResult = { ok: true; draft: GeneratedDraft } | { ok: false; problems: string[] };

/** One generated node as the definition's node: only the fields its type has; connectors unconfigured. */
function nodeOf(n: GeneratedAnswer["nodes"][number]): RawNode {
  const next = n.next === null ? {} : { next: n.next };
  switch (n.type) {
    case "condition":
      return {
        key: n.key,
        type: "condition",
        all: n.clauses,
        ...(n.then === null ? {} : { then: n.then }),
        ...(n.else === null ? {} : { else: n.else }),
      };
    case "approval":
      return {
        key: n.key,
        type: "approval",
        role: GENERATED_APPROVAL_ROLE,
        deadline: n.deadline ?? DEFAULT_APPROVAL_DEADLINE,
        onExpire: "stop",
        editable: [],
        ...next,
      };
    case "wait":
      return { key: n.key, type: "wait", duration: n.duration ?? "", ...next };
    case "end":
      return { key: n.key, type: "end", status: n.end_status ?? "succeeded" };
    default:
      // A connector: never configured from the AI's answer (or the issue behind it).
      return { key: n.key, type: n.type, input: {}, ...next };
  }
}

/**
 * Every connector node of `definition` has an empty `input`; throws otherwise. Step 2 makes it so; this
 * is the last check before a generated draft is saved.
 */
export function assertNoConfiguredOutbound(definition: Draft): void {
  for (const node of definition.nodes) {
    if ((BUILTIN_TYPES as readonly string[]).includes(String(node.type))) continue;
    const input = (node as { input?: unknown }).input;
    const empty =
      input === undefined || (typeof input === "object" && input !== null && Object.keys(input).length === 0);
    if (!empty) throw new Error(`generated node ${String(node.key)} has a configured ${String(node.type)}`);
  }
}

/** The AI's answer as a draft for workflow `key`, or why it can't be one. */
export function toDraft(answer: unknown, key: string, connectorTypes: readonly string[]): ToDraftResult {
  const parsed = generatedAnswer(connectorTypes).safeParse(answer);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "answer"}: ${i.message}`),
    };
  }
  const a = parsed.data;
  const definition: Draft = {
    version: 2,
    key,
    trigger: {
      type: "manual",
      input: a.inputs.map((f) => ({
        name: f.name,
        type: f.type,
        required: false,
        ...(f.label ? { label: f.label } : {}),
      })),
    },
    start: a.start,
    nodes: a.nodes.map(nodeOf),
  };
  const checked = parseDefinition(definition, { connectors: false });
  if (!checked.ok) return { ok: false, problems: checked.problems };
  assertNoConfiguredOutbound(definition);
  const notes: Record<string, string> = {};
  for (const n of a.nodes) if (n.note) notes[n.key] = n.note;
  return { ok: true, draft: { definition, notes, name: a.name, summary: a.summary, triggerNote: a.trigger_note } };
}
