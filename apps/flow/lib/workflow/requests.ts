/**
 * How an action step builds its request payload from the run: one typed function per request type,
 * not a template language. A workflow may only name a request type listed here (the definition is
 * refused otherwise), and the payload is checked against the event's JSON Schema when it is published.
 *
 * What a mapping reads is parsed with Zod first: a run whose data doesn't fit fails its step with
 * `request_mapping_failed` instead of publishing something half-filled.
 */
import { z } from "zod";
import type { RunContext } from "./context";

export const ISSUE_DRAFT_REQUESTED = "flow.issue-draft.requested.v1";
export const ISSUE_APPROVED = "flow.issue.approved.v1";

export interface RequestContext extends RunContext {
  /** The step that sends the request (its row id): the acting app answers with it. */
  stepId: string;
  /** The output of the latest approval step before this one that succeeded, if any. */
  approval?: unknown;
}

/** `flow.issue-draft.requested.v1` (events/flow.issue-draft.requested.v1.json). */
export interface IssueDraftRequestedV1 {
  runId: string;
  stepId: string;
  noteId: string;
  onBehalfOf: string;
}

/** `flow.issue.approved.v1` (events/flow.issue.approved.v1.json). */
export interface IssueApprovedV1 {
  runId: string;
  stepId: string;
  approvalId: string;
  noteId: string;
  onBehalfOf: string;
  decidedBy: string;
  decidedAt: string;
  repo: string;
  title: string;
  body: string;
  labels: string[];
  acknowledgedPublic: boolean;
}

export class RequestMappingError extends Error {
  override readonly name = "RequestMappingError";
}

/** The part of `docs.note.created.v1` the requests use. */
const NoteTrigger = z.object({ id: z.string().min(1), author: z.string().min(1) });

/** What an approval step's output holds once a person approved (lib/workflow/approval.ts, `Decision`). */
export const ApprovalDecision = z.object({
  approvalId: z.string().min(1),
  decidedBy: z.string().min(1),
  decidedAt: z.string().min(1),
  repo: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  labels: z.array(z.string()),
  acknowledgedPublic: z.boolean(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const where = r.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    throw new RequestMappingError(`${what} doesn't have what the request needs (${where})`);
  }
  return r.data;
}

type Mapping = (ctx: RequestContext) => object;

const MAPPINGS = {
  [ISSUE_DRAFT_REQUESTED]: (ctx): IssueDraftRequestedV1 => {
    const note = parse(NoteTrigger, ctx.trigger, "the trigger");
    return { runId: ctx.runId, stepId: ctx.stepId, noteId: note.id, onBehalfOf: note.author };
  },
  [ISSUE_APPROVED]: (ctx): IssueApprovedV1 => {
    const note = parse(NoteTrigger, ctx.trigger, "the trigger");
    const d = parse(ApprovalDecision, ctx.approval, "the approval");
    return {
      runId: ctx.runId,
      stepId: ctx.stepId,
      approvalId: d.approvalId,
      noteId: note.id,
      onBehalfOf: note.author,
      decidedBy: d.decidedBy,
      decidedAt: d.decidedAt,
      repo: d.repo,
      title: d.title,
      body: d.body,
      labels: d.labels,
      acknowledgedPublic: d.acknowledgedPublic,
    };
  },
} satisfies Record<string, Mapping>;

export type RequestType = keyof typeof MAPPINGS;

export const REQUEST_TYPES = Object.keys(MAPPINGS) as RequestType[];

export const isRequestType = (type: string): type is RequestType => Object.hasOwn(MAPPINGS, type);

/** The request payload for `type`; throws RequestMappingError when the run lacks what it needs. */
export function buildRequest(type: RequestType, ctx: RequestContext): object {
  return MAPPINGS[type](ctx);
}

/**
 * What a dry run records as the outcome of a request it doesn't send: the shape the acting app answers
 * with (docs.issue-draft.ready.v1, docs.issue.created.v1, minus runId, stepId and requestId), with
 * placeholder content, so the steps after it run on something that fits.
 */
const SIMULATED: { [T in RequestType]: (request: ReturnType<(typeof MAPPINGS)[T]>) => object } = {
  [ISSUE_DRAFT_REQUESTED]: (r) => ({
    noteId: r.noteId,
    docPath: "dry-run.md",
    repo: "dry-run/dry-run",
    public: false,
    title: "Dry run: the issue Docs would draft",
    body: "A dry run doesn't ask Docs for a draft.",
    labels: [],
  }),
  [ISSUE_APPROVED]: (r) => ({ noteId: r.noteId, issueUrl: `https://github.com/${r.repo}/issues/0` }),
};

/** The outcome a dry run records for `request` (built by `buildRequest(type, …)`). */
export function simulatedOutcome(type: RequestType, request: object): object {
  return (SIMULATED[type] as (r: object) => object)(request);
}
