/** The request registry: each request type's payload, built from the run, fits its event's JSON Schema. */
import { describe, expect, it } from "vitest";
import { publisher } from "../lib/events";
import manifest from "../platform.app";
import {
  buildRequest,
  ISSUE_APPROVED,
  ISSUE_DRAFT_REQUESTED,
  REQUEST_TYPES,
  RequestMappingError,
  type RequestContext,
} from "../lib/workflow/requests";

const ctx: RequestContext = {
  runId: "01JRUN0000000000000000000A",
  stepId: "01JSTEP000000000000000000B",
  trigger: { id: "42", author: "dev-admin", docPath: "a.md", tags: ["issue"], hasIssue: false },
  steps: {},
};
const decision = {
  approvalId: "01JAPPROVAL000000000000000",
  decidedBy: "dev-admin",
  decidedAt: "2026-10-26T11:00:00.000Z",
  repo: "AliSafari-IT/asafarim-docs",
  title: "Fix the getting-started guide",
  body: "## Context\n…",
  labels: ["docs"],
  acknowledgedPublic: false,
};

describe("request mappings", () => {
  it("every request type is one the manifest publishes", () => {
    const published = (manifest.events?.publishes ?? []).map((p) => p.type);
    expect([...REQUEST_TYPES].sort()).toEqual([...published].sort());
  });

  it(`${ISSUE_DRAFT_REQUESTED}: the run, the step, the note and who it is for; nothing else`, () => {
    const payload = buildRequest(ISSUE_DRAFT_REQUESTED, ctx);
    expect(payload).toEqual({ runId: ctx.runId, stepId: ctx.stepId, noteId: "42", onBehalfOf: "dev-admin" });
    expect(() => publisher.validate(ISSUE_DRAFT_REQUESTED, payload)).not.toThrow();
  });

  it(`${ISSUE_APPROVED}: the approval's decision, from the approval step's output`, () => {
    const payload = buildRequest(ISSUE_APPROVED, { ...ctx, approval: decision });
    expect(payload).toEqual({
      runId: ctx.runId,
      stepId: ctx.stepId,
      noteId: "42",
      onBehalfOf: "dev-admin",
      ...decision,
    });
    expect(() => publisher.validate(ISSUE_APPROVED, payload)).not.toThrow();
  });

  it("a run that lacks what the request needs is refused (RequestMappingError), naming the fields", () => {
    expect(() => buildRequest(ISSUE_DRAFT_REQUESTED, { ...ctx, trigger: { author: "x" } })).toThrow(
      RequestMappingError,
    );
    expect(() => buildRequest(ISSUE_APPROVED, ctx)).toThrow(/the approval/);
  });

  it("the schemas refuse more than the contract: extra fields, a body over 60 000, more than 20 labels", () => {
    const ok = buildRequest(ISSUE_APPROVED, { ...ctx, approval: decision });
    expect(() => publisher.validate(ISSUE_APPROVED, { ...ok, extra: 1 })).toThrow();
    expect(() => publisher.validate(ISSUE_APPROVED, { ...ok, body: "x".repeat(60_001) })).toThrow();
    expect(() =>
      publisher.validate(ISSUE_APPROVED, { ...ok, labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }),
    ).toThrow();
    expect(() =>
      publisher.validate(ISSUE_DRAFT_REQUESTED, { runId: 1, stepId: "s", noteId: "n", onBehalfOf: "o" }),
    ).toThrow();
  });
});
