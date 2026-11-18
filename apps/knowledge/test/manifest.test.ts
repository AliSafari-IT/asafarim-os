import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { validateManifest } from "@asafarim/app-manifest";
import { describe, expect, it } from "vitest";
import compiled from "../platform.app.json";
import manifest from "../platform.app";
import pkg from "../package.json";

describe("knowledge manifest", () => {
  it("is a valid app manifest, and keeps to its own namespace", () => {
    expect(validateManifest(manifest)).toMatchObject({ ok: true });
    expect(manifest.id).toBe("knowledge");
    expect(manifest.name).toBe("ASafariM Knowledge");
    for (const p of manifest.permissions) expect(p.key.startsWith("knowledge.")).toBe(true);
    for (const r of manifest.roles) expect(r.key.startsWith("knowledge.")).toBe(true);
  });

  it("has platform.app.json compiled from platform.app.ts (run `pnpm platform manifest compile` after editing it)", () => {
    const result = validateManifest(manifest);
    expect(result.ok && result.manifest).toEqual(compiled);
  });

  it("puts the studio behind knowledge.content.create at the gateway and leaves reading public", () => {
    expect(manifest.routes).toContainEqual({
      path: "/studio/**",
      methods: ["GET", "HEAD"],
      permission: "knowledge.content.create",
    });
    expect(manifest.auth.publicPaths).toEqual(expect.arrayContaining(["/", "/articles/**"]));
    expect(manifest.auth.publicPaths.some((p) => p.startsWith("/studio"))).toBe(false);
  });

  it("never puts a gateway permission on a studio POST, so an expired access token can't drop a save (#363)", () => {
    // The gateway answers a POST with an expired token with 401 (no redirect to renew it). Studio actions
    // are POSTs to /studio/**, so a route there must be limited to pages; the app authorises the actions.
    for (const r of manifest.routes ?? []) {
      if (!r.permission || !r.path.startsWith("/studio")) continue;
      expect(r.methods, r.path).toBeDefined();
      for (const m of r.methods ?? []) expect(["GET", "HEAD"]).toContain(m);
    }
  });

  it("gives authors their own articles only, and keeps any-article rights for editors", () => {
    const author = manifest.roles.find((r) => r.key === "knowledge.author")!;
    expect(author.grants.sort()).toEqual(
      [
        "knowledge.ai.use",
        "knowledge.content.create",
        "knowledge.content.edit.own",
        "knowledge.content.publish.own",
      ].sort(),
    );
    expect(author.grants.some((g) => g.endsWith(".any"))).toBe(false);
  });

  it("isn't listed in launchers before it is deployed", () => {
    expect(manifest.ui.launcher).toBeUndefined();
  });

  it("reads nothing from another app: no app dependency, no subscription, no import of apps/*", () => {
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const d of deps) expect(["@asafarim/docs", "@asafarim/notes", "@asafarim/flow"]).not.toContain(d);
    expect(manifest.events?.subscribes ?? []).toEqual([]);

    const root = path.resolve(import.meta.dirname, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", ".turbo", "test"].includes(name)) continue;
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs)$/.test(name)) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/from\s+["'](?:\.\.\/){2,}(?:apps\/)?(?:docs|notes|flow)\b/);
      expect(src, f).not.toMatch(/from\s+["']@asafarim\/(?:docs|notes|flow)["']/);
    }
  });
});
