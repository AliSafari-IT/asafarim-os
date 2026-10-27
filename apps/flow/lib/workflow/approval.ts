/**
 * What an approval step shows and what a decision may change, checked with Zod: the draft comes from
 * another app (untrusted), and the edits from a form.
 *
 * - **The draft** is the output of the action step just before the approval (`docs.issue-draft.ready.v1`
 *   minus `runId`, `stepId` and `requestId`). A draft that doesn't fit fails the approval step with
 *   `invalid_draft` before anyone is asked.
 * - **Edits** may only change the fields the step names in `editable`, within the same limits.
 * - **The decision** (the step's output once approved) is what the next action builds its request from
 *   (lib/workflow/requests.ts, `ApprovalDecision`).
 */
import { z } from "zod";
import type { ApprovalStep } from "./definition";
import { BODY_MAX, LABEL_MAX, LABELS_MAX, TITLE_MAX } from "./limits";

export * from "./limits";

/** owner/name, as GitHub allows it (the same pattern as flow.issue.approved.v1's `repo`). */
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

const Title = z.string().min(1).max(TITLE_MAX);
const Body = z.string().min(1).max(BODY_MAX);
const Labels = z
  .array(z.string().min(1).max(LABEL_MAX))
  .max(LABELS_MAX)
  .refine((l) => new Set(l).size === l.length, "labels must be distinct");

/** The draft an approver reviews. Unknown fields (the outcome's runId, stepId, requestId) are dropped. */
export const Draft = z.object({
  noteId: z.string().min(1).max(64),
  docPath: z.string().min(1).max(1024),
  repo: z.string().regex(REPO),
  public: z.boolean(),
  title: Title,
  body: Body,
  labels: Labels,
});
export type Draft = z.infer<typeof Draft>;

export const EDITABLE = ["title", "body", "labels"] as const;
export type Editable = (typeof EDITABLE)[number];

export const Edits = z.strictObject({ title: Title.optional(), body: Body.optional(), labels: Labels.optional() });
export type Edits = z.infer<typeof Edits>;

/** The approval step's output once approved: what the request after it is built from. */
export interface Decision {
  noteId: string;
  repo: string;
  title: string;
  body: string;
  labels: string[];
  acknowledgedPublic: boolean;
  approvalId: string;
  decidedBy: string;
  decidedAt: string;
}

export type EditsResult =
  | { ok: true; final: Pick<Draft, Editable>; changed: Partial<Pick<Draft, Editable>> | null }
  | { ok: false; error: "edit_not_allowed" | "invalid_edits" };

/**
 * Apply `edits` to `draft` under `step.editable`: the final fields and only those that changed (null
 * when none did). A field outside `editable` is refused even when its value is the draft's own.
 */
export function applyEdits(draft: Draft, step: Pick<ApprovalStep, "editable">, edits: unknown): EditsResult {
  const parsed = Edits.safeParse(edits ?? {});
  if (!parsed.success) {
    const unknownKey = parsed.error.issues.some((i) => i.code === "unrecognized_keys");
    return { ok: false, error: unknownKey ? "edit_not_allowed" : "invalid_edits" };
  }
  const allowed = new Set<string>(step.editable);
  const final: Pick<Draft, Editable> = { title: draft.title, body: draft.body, labels: draft.labels };
  const changed: Partial<Pick<Draft, Editable>> = {};
  for (const key of EDITABLE) {
    const value = parsed.data[key];
    if (value === undefined) continue;
    if (!allowed.has(key)) return { ok: false, error: "edit_not_allowed" };
    const same = Array.isArray(value)
      ? JSON.stringify(value) === JSON.stringify(draft.labels)
      : value === draft[key as "title" | "body"];
    if (same) continue;
    (final as Record<Editable, unknown>)[key] = value;
    (changed as Record<Editable, unknown>)[key] = value;
  }
  return { ok: true, final, changed: Object.keys(changed).length ? changed : null };
}
