import { validateManifest } from "@asafarim/app-manifest";
import { describe, expect, it } from "vitest";
import manifest from "../platform.app";

describe("notes manifest", () => {
  it("is a valid app manifest", () => {
    expect(validateManifest(manifest)).toMatchObject({ ok: true });
  });

  it("declares exactly notes.read and notes.write, and the two roles an admin can grant", () => {
    expect(manifest.permissions.map((p) => p.key)).toEqual(["notes.read", "notes.write"]);
    expect(manifest.roles).toEqual([
      expect.objectContaining({ key: "notes.viewer", grants: ["notes.read"] }),
      expect.objectContaining({ key: "notes.editor", grants: ["notes.read", "notes.write"] }),
    ]);
  });

  it("protects the API routes with those permissions (reading and writing differ)", () => {
    const byMethod = Object.fromEntries((manifest.routes ?? []).map((r) => [r.methods?.join(","), r.permission]));
    expect(byMethod).toEqual({ GET: "notes.read", POST: "notes.write" });
  });

  it("stays inside its own namespace and signs in through OIDC", () => {
    for (const p of manifest.permissions) expect(p.key.startsWith("notes.")).toBe(true);
    expect(manifest.auth.client).toBe("oidc");
    expect(manifest.config?.map((c) => c.key)).toEqual(["limits.maxNotes"]);
  });
});
