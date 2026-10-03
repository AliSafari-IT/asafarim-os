import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverManifests, findRepoRoot, generatedFiles, sync } from "./sync.ts";

let root: string;

function write(rel: string, content = "") {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

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
    expect(result.lines).toContain("generated/platform/ is up to date.");
  });

  it("ignores the directory's own README and .gitkeep", () => {
    write("generated/platform/.gitkeep");
    expect(generatedFiles(root)).toEqual([]);
  });

  it("reports drift when generated/platform/ holds files no manifest produces", () => {
    write("generated/platform/compose/web.yml", "services: {}\n");
    const result = sync(root, { check: true });
    expect(result.ok).toBe(false);
    expect(result.lines).toContain("  - generated/platform/compose/web.yml");
  });

  it("discovers apps/<id>/platform.app.json and refuses while no generator exists", () => {
    write("apps/web/platform.app.json", "{}");
    write("apps/notes/README.md");
    expect(discoverManifests(root).map((f) => path.relative(root, f).split(path.sep).join("/"))).toEqual([
      "apps/web/platform.app.json",
    ]);
    const result = sync(root, { check: false });
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toBe("Found 1 app manifest(s).");
  });
});
