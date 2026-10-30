import { readFileSync } from "node:fs";
import path from "node:path";
import { launcherEntries, validateManifest } from "@asafarim/app-manifest";
import { describe, expect, it } from "vitest";
import compiled from "../platform.app.json";
import registry from "../../../generated/platform/launcher-registry.json";
import manifest from "../platform.app";

describe("flow manifest", () => {
  it("is a valid app manifest, and keeps to its own namespace", () => {
    expect(validateManifest(manifest)).toMatchObject({ ok: true });
    for (const p of manifest.permissions) expect(p.key.startsWith("flow.")).toBe(true);
    for (const r of manifest.roles) expect(r.key.startsWith("flow.")).toBe(true);
    for (const e of manifest.events?.publishes ?? []) expect(e.type.startsWith("flow.")).toBe(true);
  });

  it("is in the OS app switcher (#278): its tile, for people who hold a flow role, at its canonical domain, after Docs", () => {
    // core-api's launcher and `platform sync` both build the switcher from launcherEntries.
    const [tile] = launcherEntries([manifest]);
    expect(tile).toEqual({
      key: "flow",
      name: "Flow",
      description: expect.stringContaining("Workflows"),
      glyph: "FL",
      color: "#2563eb",
      meta: "flow.asafarim.site",
      status: "active",
      // Not public: core-api lists it only for someone who holds a flow.* role.
      access: "authenticated",
      order: 30,
    });
    expect(manifest.domains?.primary).toBe("flow.asafarim.site");
    // The generated registry (kept in step by `platform sync --check` in CI) lists it once, after Docs.
    const keys = registry.apps.map((a) => a.key);
    expect(keys.filter((k) => k === "flow")).toHaveLength(1);
    expect(keys.indexOf("flow")).toBeGreaterThan(keys.indexOf("docs"));
    expect(registry.apps.find((a) => a.key === "flow")).toEqual(tile);
  });

  it("has platform.app.json compiled from platform.app.ts (run `pnpm platform manifest compile` after editing it)", () => {
    const result = validateManifest(manifest);
    expect(result.ok && result.manifest).toEqual(compiled);
  });

  it("grants what ADR 0001 decided: read for every role, workflows, runs, credentials, settings and AI drafting (#283) for the owner (ADR 0002), approvals for approvers", () => {
    const grants = Object.fromEntries(manifest.roles.map((r) => [r.key, [...r.grants].sort()]));
    expect(grants).toEqual({
      "flow.viewer": ["flow.read"],
      "flow.approver": ["flow.approvals.decide", "flow.read"],
      "flow.owner": [
        "flow.approvals.decide",
        "flow.credentials.write",
        "flow.read",
        "flow.runs.start",
        "flow.settings.write",
        "flow.workflows.generate",
        "flow.workflows.write",
      ],
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

describe("Flow's favicon (#302)", () => {
  it("is its own: app/icon.svg, a tile in the manifest's brand colour, like its tile in the app switcher", () => {
    const svg = readFileSync(path.join(import.meta.dirname, "..", "app", "icon.svg"), "utf8");
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32">/);
    expect(svg).toContain(`stop-color="${manifest.ui.color}"`);
    // Only drawing: no script, no external reference.
    expect(svg).not.toMatch(/<script|href=|url\((?!#g\))/i);
  });
});
