import { validateManifest } from "@asafarim/app-manifest";
import { describe, expect, it } from "vitest";
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
});
