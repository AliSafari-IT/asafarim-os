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
 */
import { z } from "zod";
import { FIELD_PATH, stepKeyOf } from "./context";
import { durationMs } from "./duration";
import { isRequestType, REQUEST_TYPES } from "./requests";

/** `<app>.<entity>.<verb>.v<N>`, the manifest's rule. */
const EVENT_TYPE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.v[1-9]\d*$/;
const KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const eventType = z.string().regex(EVENT_TYPE, "must be an event type <app>.<entity>.<verb>.v<N>");
const stepKey = z.string().max(40).regex(KEY, "must be kebab-case");
const duration = z
  .string()
  .refine((d) => durationMs(d) !== undefined, "must be an ISO 8601 duration in days, hours, minutes or seconds");

export const Clause = z.strictObject({
  field: z.string().regex(FIELD_PATH, "must be trigger.<field> or steps.<key>.output.<field>"),
  op: z.enum(["equals", "notEquals", "contains"]),
  value: z.union([z.string().max(200), z.number(), z.boolean(), z.null()]),
});
export type Clause = z.infer<typeof Clause>;

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
  role: z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/, "must be a role key"),
  deadline: duration,
  onExpire: z.literal("stop"),
  editable: z.array(z.enum(["title", "body", "labels"])).max(3),
});

const EndStep = z.strictObject({ key: stepKey, type: z.literal("end") });

export const Step = z.discriminatedUnion("type", [ConditionStep, ActionStep, ApprovalStep, EndStep]);
export type Step = z.infer<typeof Step>;
export type ConditionStep = z.infer<typeof ConditionStep>;
export type ActionStep = z.infer<typeof ActionStep>;
export type ApprovalStep = z.infer<typeof ApprovalStep>;

export const WorkflowDefinition = z
  .strictObject({
    key: z.string().max(64).regex(KEY, "must be kebab-case"),
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

export type DefinitionResult = { ok: true; definition: WorkflowDefinition } | { ok: false; problems: string[] };

export function parseDefinition(value: unknown): DefinitionResult {
  const r = WorkflowDefinition.safeParse(value);
  if (r.success) return { ok: true, definition: r.data };
  return { ok: false, problems: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

/** The part of a manifest a definition is checked against. */
export interface EventsManifest {
  events?: { publishes?: readonly { type: string }[]; subscribes?: readonly { type: string }[] };
}

/**
 * What the definition needs from the manifest: its trigger and every outcome are subscribed, and
 * every request is published. Without that core-api never delivers the event (or refuses it).
 */
export function manifestProblems(def: WorkflowDefinition, manifest: EventsManifest): string[] {
  const publishes = new Set((manifest.events?.publishes ?? []).map((p) => p.type));
  const subscribes = new Set((manifest.events?.subscribes ?? []).map((s) => s.type));
  const problems: string[] = [];
  const sub = (type: string, what: string) => {
    if (!subscribes.has(type)) problems.push(`${what} ${type} isn't in events.subscribes`);
  };
  sub(def.trigger.event, "the trigger");
  for (const step of def.steps) {
    if (step.type !== "action") continue;
    if (!publishes.has(step.request)) problems.push(`step ${step.key}: ${step.request} isn't in events.publishes`);
    sub(step.done, `step ${step.key}:`);
    sub(step.failed, `step ${step.key}:`);
  }
  return problems;
}

/** The milliseconds of an action's timeout or an approval's deadline (the schema accepted it). */
export const msOf = (d: string): number => durationMs(d)!;
