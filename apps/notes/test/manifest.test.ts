import path from "node:path";
import { validateManifest } from "@asafarim/app-manifest";
import { EventValidationError, loadSchemas } from "@asafarim/app-sdk/events";
import { describe, expect, it } from "vitest";
import { publisher } from "../lib/events";
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

  it("publishes notes.note.created.v1 (P4.1), whose schema file exists and refuses a bad payload", () => {
    expect(manifest.events?.publishes).toEqual([
      { type: "notes.note.created.v1", schema: "./events/notes.note.created.v1.json" },
    ]);
    // The schema the app validates with is the file the manifest names.
    const onDisk = loadSchemas(manifest, path.resolve(import.meta.dirname, ".."));
    expect(Object.keys(onDisk)).toEqual(["./events/notes.note.created.v1.json"]);
    expect(publisher.types).toEqual(["notes.note.created.v1"]);
    const ok = { id: "1", author: "dev-member", title: "Hi", createdAt: "2026-10-09T12:00:00.000Z" };
    expect(() => publisher.validate("notes.note.created.v1", ok)).not.toThrow();
    expect(() => publisher.validate("notes.note.created.v1", { ...ok, id: 1 })).toThrow(EventValidationError);
    expect(() => publisher.validate("notes.note.created.v1", { ...ok, body: "x" })).toThrow(EventValidationError);
  });
});
