import path from "node:path";
import { validateManifest } from "@asafarim/app-manifest";
import { loadSchemas } from "@asafarim/app-sdk/events";
import { describe, expect, it } from "vitest";
import { publisher } from "../lib/events";
import { EVENT_SCHEMAS } from "../lib/schemas";
import manifest from "../platform.app";

describe("docs manifest", () => {
  it("is a valid app manifest", () => {
    expect(validateManifest(manifest)).toMatchObject({ ok: true });
  });

  it("declares its three permissions and one owner role that grants them all (an admin grants it)", () => {
    expect(manifest.permissions.map((p) => p.key)).toEqual(["docs.read", "docs.notes.write", "docs.issues.create"]);
    expect(manifest.roles).toEqual([
      expect.objectContaining({ key: "docs.owner", grants: ["docs.read", "docs.notes.write", "docs.issues.create"] }),
    ]);
  });

  it("stays inside its own namespace, signs in through OIDC and only exposes its health check", () => {
    for (const p of manifest.permissions) expect(p.key.startsWith("docs.")).toBe(true);
    expect(manifest.auth).toEqual({ client: "oidc", publicPaths: ["/api/health"] });
    expect(manifest.domains?.primary).toBe("docs.asafarim.site");
    expect(manifest.database).toEqual({ engine: "postgres", migrations: "sql" });
  });

  it("names its secrets (never values) and keeps the source repository and the model in config", () => {
    expect(manifest.secrets).toEqual(["DOCS_GITHUB_TOKEN", "DOCS_ISSUES_TOKEN", "DOCS_AI_API_KEY"]);
    expect(manifest.config?.map((c) => [c.key, c.type])).toEqual([
      ["source.repo", "string"],
      ["source.branch", "string"],
      ["ai.model", "string"],
    ]);
  });

  it("isn't public: the launcher lists it only for people who hold a role in it", () => {
    expect(manifest.ui.launcher?.access).toBe("authenticated");
  });

  it("declares bounded resources for the shared host", () => {
    expect(manifest.runtime.resources).toEqual({ memory: "256m", cpus: 0.5 });
  });

  it("publishes its Flow events, and hands the SDK the schema files the manifest names", () => {
    expect(manifest.events?.publishes).toEqual([
      { type: "docs.note.created.v1", schema: "./events/docs.note.created.v1.json" },
      { type: "docs.issue-draft.ready.v1", schema: "./events/docs.issue-draft.ready.v1.json" },
      { type: "docs.issue-draft.failed.v1", schema: "./events/docs.issue-draft.failed.v1.json" },
      { type: "docs.issue.created.v1", schema: "./events/docs.issue.created.v1.json" },
      { type: "docs.issue.failed.v1", schema: "./events/docs.issue.failed.v1.json" },
    ]);
    // The schema the app validates with (and uploads for the event catalog) is the file the manifest names.
    expect(EVENT_SCHEMAS).toEqual(loadSchemas(manifest, path.resolve(import.meta.dirname, "..")));
    expect(publisher.types).toEqual([
      "docs.note.created.v1",
      "docs.issue-draft.ready.v1",
      "docs.issue-draft.failed.v1",
      "docs.issue.created.v1",
      "docs.issue.failed.v1",
    ]);
  });

  it("answers Flow's requests to draft an issue and to create the approved one", () => {
    expect(manifest.events?.subscribes).toEqual([
      { type: "flow.issue-draft.requested.v1", handler: "/events/issue-draft-requested" },
      { type: "flow.issue.approved.v1", handler: "/events/issue-approved" },
    ]);
  });
});
