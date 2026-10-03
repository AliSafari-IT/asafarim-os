import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAUNCHER_REGISTRY, discoverManifests, findRepoRoot, generatedFiles, launcherRegistry, sync } from "./sync.ts";

let root: string;

function write(rel: string, content = "") {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function manifest(id: string, launcher?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id.toUpperCase(),
    version: "1.0.0",
    platform: ">=0.1 <1",
    owner: "ASafariM Digital",
    runtime: { image: id, port: 3000, health: { live: "/h", ready: "/h" }, resources: { memory: "128m", cpus: 0.25 } },
    database: { engine: "none" },
    auth: { client: "none", publicPaths: ["/"] },
    permissions: [],
    roles: [],
    ui: { glyph: "XX", color: "#000000", nav: [], status: "active", ...(launcher ? { launcher } : {}) },
    ...extra,
  };
}

const app = (id: string, launcher?: Record<string, unknown>) =>
  write(`apps/${id}/platform.app.json`, JSON.stringify(manifest(id, launcher)));

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "platform-cli-"));
  write("pnpm-workspace.yaml", "packages: []\n");
  write("generated/platform/README.md", "# generated\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("platform sync", () => {
  it("finds the workspace root from a nested directory", () => {
    write("tools/platform-cli/src/.keep");
    expect(findRepoRoot(path.join(root, "tools", "platform-cli", "src"))).toBe(root);
  });

  it("passes --check on an empty platform: no manifests, no generated files", () => {
    const result = sync(root, { check: true });
    expect(result.ok).toBe(true);
    expect(result.lines.at(-1)).toBe("generated/platform/ is up to date (0 file(s)).");
  });

  it("ignores the directory's own README and .gitkeep", () => {
    write("generated/platform/.gitkeep");
    expect(generatedFiles(root)).toEqual([]);
  });

  it("discovers apps/<id>/platform.app.json only (never a .ts module)", () => {
    app("web");
    write("apps/notes/platform.app.ts", "export default {};");
    expect(discoverManifests(root).map((f) => path.relative(root, f).split(path.sep).join("/"))).toEqual([
      "apps/web/platform.app.json",
    ]);
  });

  it("generates the launcher registry from ui.launcher, ordered by `order` then id", () => {
    app("web", { description: "Studio site", meta: "asafarim.com", access: "public", order: 10 });
    app("hub", { description: "Workbench", meta: "hub", access: "authenticated", order: 20 });
    app("vionto", { description: "Video", meta: "vionto", access: "public", requiresAccountToUse: true, order: 20 });
    app("worker-only"); // no launcher: not listed

    const result = sync(root, { check: false });
    expect(result.ok).toBe(true);
    expect(result.lines).toContain(`  wrote ${LAUNCHER_REGISTRY}`);
    const doc = JSON.parse(readFileSync(path.join(root, LAUNCHER_REGISTRY), "utf8"));
    expect(doc.apps.map((a: { key: string }) => a.key)).toEqual(["web", "hub", "vionto"]);
    expect(doc.apps[2]).toEqual({
      key: "vionto",
      name: "VIONTO",
      description: "Video",
      glyph: "XX",
      meta: "vionto",
      status: "active",
      access: "public",
      requiresAccountToUse: true,
      order: 20,
    });
    expect("requiresAccountToUse" in doc.apps[0]).toBe(false);
    expect(doc.$comment).toMatch(/Do not edit/);
  });

  it("--check passes right after sync, and fails when the output is stale or hand-edited", () => {
    app("web", { description: "Studio site", meta: "asafarim.com", access: "public", order: 10 });
    expect(sync(root, { check: true }).ok).toBe(false); // not generated yet
    sync(root, { check: false });
    expect(sync(root, { check: true }).ok).toBe(true);

    const file = path.join(root, LAUNCHER_REGISTRY);
    writeFileSync(file, readFileSync(file, "utf8").replace("Studio site", "Hand-edited"));
    const stale = sync(root, { check: true });
    expect(stale.ok).toBe(false);
    expect(stale.lines).toContain(`  - ${LAUNCHER_REGISTRY}`);
  });

  it("--check ignores CRLF line endings in the committed file (Windows checkouts)", () => {
    app("web", { description: "Studio site", meta: "asafarim.com", access: "public", order: 10 });
    sync(root, { check: false });
    const file = path.join(root, LAUNCHER_REGISTRY);
    writeFileSync(file, readFileSync(file, "utf8").replace(/\n/g, "\r\n"));
    expect(sync(root, { check: true }).ok).toBe(true);
  });

  it("reports drift for generated files no manifest produces", () => {
    write("generated/platform/compose/web.yml", "services: {}\n");
    const result = sync(root, { check: true });
    expect(result.ok).toBe(false);
    expect(result.lines).toContain("  - generated/platform/compose/web.yml");
  });

  it("refuses invalid manifests and duplicate ids before generating anything", () => {
    write("apps/bad/platform.app.json", JSON.stringify({ ...manifest("bad"), version: "one" }));
    const invalid = sync(root, { check: false });
    expect(invalid.ok).toBe(false);
    expect(invalid.lines.join("\n")).toMatch(/apps\/bad\/platform\.app\.json: 1 problem\(s\)/);

    rmSync(path.join(root, "apps", "bad"), { recursive: true });
    write("apps/a/platform.app.json", JSON.stringify(manifest("same")));
    write("apps/b/platform.app.json", JSON.stringify(manifest("same")));
    expect(sync(root, { check: false }).lines).toContain('✖ 2 manifests declare the id "same"');
  });

  it("launcherRegistry keeps only manifests with a launcher block", () => {
    expect(launcherRegistry([])).toEqual([]);
  });
});
