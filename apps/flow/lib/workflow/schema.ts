/**
 * The pieces both definition formats share (v1: lib/workflow/definition.ts, v2:
 * lib/workflow/definition-v2.ts): keys, event types, durations and a condition's clauses.
 */
import { z } from "zod";
import { FIELD_PATH } from "./context";
import { durationMs } from "./duration";

/** `<app>.<entity>.<verb>.v<N>`, the manifest's rule. */
export const EVENT_TYPE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.v[1-9]\d*$/;
export const KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** A role key, `<app>.<role>`. */
export const ROLE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

export const eventType = z.string().regex(EVENT_TYPE, "must be an event type <app>.<entity>.<verb>.v<N>");
export const stepKey = z.string().max(40).regex(KEY, "must be kebab-case");
export const workflowKey = z.string().max(64).regex(KEY, "must be kebab-case");
export const duration = z
  .string()
  .refine((d) => durationMs(d) !== undefined, "must be an ISO 8601 duration in days, hours, minutes or seconds");

export const Clause = z.strictObject({
  field: z.string().regex(FIELD_PATH, "must be trigger.<field> or steps.<key>.output.<field>"),
  op: z.enum(["equals", "notEquals", "contains"]),
  value: z.union([z.string().max(200), z.number(), z.boolean(), z.null()]),
});
export type Clause = z.infer<typeof Clause>;

/** The fields an approval may let the approver edit (the issue draft's). */
export const editableFields = z.array(z.enum(["title", "body", "labels"])).max(3);

/** A problem with a definition: where (the node's key when it is about one node) and what. */
export interface Problem {
  node?: string;
  path: string;
  message: string;
}

/** `node <key>: <path>: <message>`, the way a problem is written in a log or an error. */
export const problemText = (p: Problem) =>
  `${p.node ? `node ${p.node}: ` : ""}${p.path ? `${p.path}: ` : ""}${p.message}`;
