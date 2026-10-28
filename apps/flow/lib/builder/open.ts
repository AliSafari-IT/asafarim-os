/**
 * What the builder opens (server only): the workflow's draft when it has one; otherwise its published
 * version, which the first save turns into a draft (a version 1 definition converted to version 2,
 * the builder's format); otherwise a trigger and an end.
 */
import type { BuilderWorkflow } from "../queries";
import { isV2 } from "../workflow/definition";
import { starterDraft } from "./ops";
import type { Draft } from "./types";
import { v1ToV2 } from "./v1";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `value` as the builder's draft: the fields it reads always there, whatever was saved. */
export function asDraft(value: Record<string, unknown>, key: string): Draft {
  return {
    ...value,
    version: 2,
    key: typeof value.key === "string" ? value.key : key,
    trigger: isRecord(value.trigger) ? value.trigger : { type: "manual", input: [] },
    start: typeof value.start === "string" ? value.start : "",
    nodes: Array.isArray(value.nodes) ? value.nodes.map((n) => (isRecord(n) ? n : {})) : [],
  };
}

export type Opened = { draft: Draft; from: "draft" | "version" | "v1" | "new" };

export function openWorkflow(w: Pick<BuilderWorkflow, "key" | "draft" | "current">): Opened {
  if (isRecord(w.draft) && w.draft.version === 2) return { draft: asDraft(w.draft, w.key), from: "draft" };
  const def = w.current?.definition;
  if (def && isV2(def)) return { draft: asDraft(def as unknown as Record<string, unknown>, w.key), from: "version" };
  if (def) return { draft: v1ToV2(def), from: "v1" };
  return { draft: starterDraft(w.key, { type: "manual", input: [] }), from: "new" };
}

export const draftOf = (w: Pick<BuilderWorkflow, "key" | "draft" | "current">): Draft => openWorkflow(w).draft;
