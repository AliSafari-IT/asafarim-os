/**
 * The workflow definition: a typed format, checked with Zod before a version is stored. A version is
 * immutable once published; a run is pinned to the version it started on.
 *
 *   { key, trigger: { event }, steps: [condition | action | approval | end, …] }
 *
 * - **condition** `{ all: [{ field, op, value }] }`: every clause holds → the next step; otherwise the
 *   run ends `skipped`. Ops: `equals`, `notEquals`, `contains` (lib/workflow/conditions.ts).
 * - **action** `{ request, done, failed, timeout }`: publish `request` (a type with a mapping in
 *   lib/workflow/requests.ts) and wait for `done` or `failed` from the acting app, for `timeout` at most.
 * - **approval** `{ role, deadline, onExpire, editable }`: wait for a person holding `role`.
 * - **end**: the run succeeded. Exactly one, and the last step.
 *
 * Fields are paths into `trigger.*` and `steps.<key>.output.*`, where `<key>` is an earlier step.
 *
 * Version 2 (`version: 2`), a graph of nodes, is lib/workflow/definition-v2.ts; `parseDefinition` reads
 * either, and the engine runs both (lib/workflow/graph.ts).
 */
import { z } from "zod";
import { stepKeyOf } from "./context";
import { durationMs } from "./duration";
import { validateV2, type TriggerV2, type ValidateOptions, type WorkflowDefinitionV2 } from "./definition-v2";
import { isRequestType, REQUEST_TYPES } from "./requests";
import {
  Clause,
  duration,
  editableFields,
  eventType,
  problemText,
  ROLE,
  stepKey,
  workflowKey,
  type Problem,
} from "./schema";

export { Clause, type Problem } from "./schema";

const ConditionStep = z.strictObject({
  key: stepKey,
  type: z.literal("condition"),
  all: z.array(Clause).min(1).max(20),
});

const ActionStep = z.strictObject({
  key: stepKey,
  type: z.literal("action"),
  request: eventType.refine(isRequestType, `must be a request Flow can build (${REQUEST_TYPES.join(", ")})`),
  done: eventType,
  failed: eventType,
  timeout: duration,
});

const ApprovalStep = z.strictObject({
  key: stepKey,
  type: z.literal("approval"),
  role: z.string().regex(ROLE, "must be a role key"),
  deadline: duration,
  onExpire: z.literal("stop"),
  editable: editableFields,
});

const EndStep = z.strictObject({ key: stepKey, type: z.literal("end") });

export const Step = z.discriminatedUnion("type", [ConditionStep, ActionStep, ApprovalStep, EndStep]);
export type Step = z.infer<typeof Step>;
export type ConditionStep = z.infer<typeof ConditionStep>;
export type ActionStep = z.infer<typeof ActionStep>;
export type ApprovalStep = z.infer<typeof ApprovalStep>;

export const WorkflowDefinition = z
  .strictObject({
    key: workflowKey,
    trigger: z.strictObject({ event: eventType }),
    steps: z.array(Step).min(1).max(50),
  })
  .superRefine((def, ctx) => {
    const seen = new Set<string>();
    def.steps.forEach((step, i) => {
      if (seen.has(step.key))
        ctx.addIssue({ code: "custom", path: ["steps", i, "key"], message: "duplicate step key" });
      if (step.type === "condition") {
        step.all.forEach((c, j) => {
          const key = stepKeyOf(c.field);
          if (key !== undefined && !seen.has(key)) {
            ctx.addIssue({
              code: "custom",
              path: ["steps", i, "all", j, "field"],
              message: `reads step "${key}", which isn't an earlier step`,
            });
          }
        });
      }
      if (step.type === "action" && step.done === step.failed) {
        ctx.addIssue({ code: "custom", path: ["steps", i, "failed"], message: "must differ from done" });
      }
      if (step.type === "end" && i !== def.steps.length - 1) {
        ctx.addIssue({ code: "custom", path: ["steps", i], message: "end must be the last step" });
      }
      seen.add(step.key);
    });
    if (def.steps.at(-1)?.type !== "end") {
      ctx.addIssue({ code: "custom", path: ["steps"], message: "the last step must be an end step" });
    }
  });
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

/** Either version: v1 (`steps`) or v2 (`version: 2`, a graph: lib/workflow/definition-v2.ts). */
export type AnyWorkflowDefinition = WorkflowDefinition | WorkflowDefinitionV2;

export const isV2 = (def: AnyWorkflowDefinition): def is WorkflowDefinitionV2 => "version" in def && def.version === 2;

/** The definition's trigger in v2's terms (a v1 trigger is an `event` one). */
export const triggerOf = (def: AnyWorkflowDefinition): TriggerV2 =>
  isV2(def) ? def.trigger : { type: "event", event: def.trigger.event };

export type DefinitionResult =
  { ok: true; definition: AnyWorkflowDefinition } | { ok: false; problems: string[]; issues: Problem[] };

/** A v1 issue's node: the key of the step its path starts in. */
function v1Problem(value: unknown, issue: z.core.$ZodIssue): Problem {
  const [first, index, ...rest] = issue.path;
  const steps = (value as { steps?: unknown })?.steps;
  const step = first === "steps" && typeof index === "number" && Array.isArray(steps) ? steps[index] : undefined;
  const key = (step as { key?: unknown } | undefined)?.key;
  if (typeof key === "string") return { node: key, path: rest.map(String).join("."), message: issue.message };
  return { path: issue.path.map(String).join("."), message: issue.message };
}

/**
 * Parse a definition of either version: the definition, or every problem (as text, and as `issues`
 * with the node each one is about).
 */
export function parseDefinition(value: unknown, opts: ValidateOptions = {}): DefinitionResult {
  if (typeof value === "object" && value !== null && "version" in value) {
    const r = validateV2(value, opts);
    if (r.ok) return r;
    return { ok: false, issues: r.problems, problems: r.problems.map(problemText) };
  }
  const r = WorkflowDefinition.safeParse(value);
  if (r.success) return { ok: true, definition: r.data };
  return {
    ok: false,
    problems: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    issues: r.error.issues.map((i) => v1Problem(value, i)),
  };
}

/** The part of a manifest a definition is checked against. */
export interface EventsManifest {
  events?: { publishes?: readonly { type: string }[]; subscribes?: readonly { type: string }[] };
}

/**
 * What the definition needs from the manifest: its trigger and every outcome are subscribed, and
 * every request is published. Without that core-api never delivers the event (or refuses it).
 */
export function manifestProblems(def: AnyWorkflowDefinition, manifest: EventsManifest): string[] {
  const publishes = new Set((manifest.events?.publishes ?? []).map((p) => p.type));
  const subscribes = new Set((manifest.events?.subscribes ?? []).map((s) => s.type));
  const problems: string[] = [];
  const sub = (type: string, what: string) => {
    if (!subscribes.has(type)) problems.push(`${what} ${type} isn't in events.subscribes`);
  };
  const actions = isV2(def)
    ? def.nodes.flatMap((n) => {
        const io = DOCS_NODES[n.type as keyof typeof DOCS_NODES];
        return io ? [{ key: n.key, ...io }] : [];
      })
    : def.steps.filter((s): s is ActionStep => s.type === "action");
  if (!isV2(def)) sub(def.trigger.event, "the trigger");
  else if (def.trigger.type === "event") sub(def.trigger.event, "the trigger");
  for (const step of actions) {
    if (!publishes.has(step.request)) problems.push(`step ${step.key}: ${step.request} isn't in events.publishes`);
    sub(step.done, `step ${step.key}:`);
    sub(step.failed, `step ${step.key}:`);
  }
  return problems;
}

/** The request each Docs node of a v2 definition publishes, and the outcomes it waits for (as v1's action steps). */
export const DOCS_NODES = {
  "docs.issue-draft": {
    request: "flow.issue-draft.requested.v1",
    done: "docs.issue-draft.ready.v1",
    failed: "docs.issue-draft.failed.v1",
  },
  "docs.issue-create": {
    request: "flow.issue.approved.v1",
    done: "docs.issue.created.v1",
    failed: "docs.issue.failed.v1",
  },
} as const;

/** The milliseconds of an action's timeout or an approval's deadline (the schema accepted it). */
export const msOf = (d: string): number => durationMs(d)!;
