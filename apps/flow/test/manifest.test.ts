import { validateManifest } from "@asafarim/app-manifest";
import { describe, expect, it } from "vitest";
import compiled from "../platform.app.json";
import manifest from "../platform.app";

describe("flow manifest", () => {
  it("is a valid app manifest, and keeps to its own namespace", () => {
    expect(validateManifest(manifest)).toMatchObject({ ok: true });
    for (const p of manifest.permissions) expect(p.key.startsWith("flow.")).toBe(true);
    for (const r of manifest.roles) expect(r.key.startsWith("flow.")).toBe(true);
    for (const e of manifest.events?.publishes ?? []) expect(e.type.startsWith("flow.")).toBe(true);
  });

  it("has platform.app.json compiled from platform.app.ts (run `pnpm platform manifest compile` after editing it)", () => {
    const result = validateManifest(manifest);
    expect(result.ok && result.manifest).toEqual(compiled);
  });

  it("grants what ADR 0001 decided: read for every role, workflows and runs for the owner, approvals for approvers", () => {
    const grants = Object.fromEntries(manifest.roles.map((r) => [r.key, [...r.grants].sort()]));
    expect(grants).toEqual({
      "flow.viewer": ["flow.read"],
      "flow.approver": ["flow.approvals.decide", "flow.read"],
      "flow.owner": ["flow.approvals.decide", "flow.read", "flow.runs.start", "flow.workflows.write"],
    });
  });

  it("subscribes to Docs' trigger and outcomes, and publishes its two requests", () => {
    expect(manifest.events?.subscribes?.map((s) => s.type)).toEqual([
      "docs.note.created.v1",
      "docs.issue-draft.ready.v1",
      "docs.issue-draft.failed.v1",
      "docs.issue.created.v1",
      "docs.issue.failed.v1",
    ]);
    expect(manifest.events?.publishes?.map((p) => p.type)).toEqual([
      "flow.issue-draft.requested.v1",
      "flow.issue.approved.v1",
    ]);
  });
});
