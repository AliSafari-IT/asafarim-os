/**
 * A scaffolded app, end to end: generated into a temporary workspace, it validates, `sync` wires it,
 * its manifest compiles back to the JSON that was written, and it typechecks, lints and passes its own
 * test. The third-party packages come from apps/notes (the generated package.json asks for a subset of
 * its dependencies), linked in as the app's node_modules the way `pnpm install` would.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileCommand, validateCommand } from "./manifest.ts";
import { scaffoldApp } from "./scaffold.ts";
import { GATEWAY_CADDYFILE, LAUNCHER_REGISTRY, sync } from "./sync.ts";

const donor = path.resolve(import.meta.dirname, "..", "..", "..", "apps", "notes", "node_modules");
const ID = "demo-hello";
let root: string;
let appDir: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "scaffold-int-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');
  const result = scaffoldApp(root, { id: ID });
  expect(result.lines.join("\n")).toContain("✔ created");
  appDir = path.join(root, "apps", ID);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(bin: string, args: string[]) {
  const script = realpathSync(path.join(donor, bin));
  const out = spawnSync(process.execPath, [script, ...args], { cwd: appDir, encoding: "utf8", timeout: 110_000 });
  return { status: out.status, output: `${out.stdout}${out.stderr}` };
}

describe("a scaffolded app", () => {
  it("passes `manifest validate`", async () => {
    const result = await validateCommand(path.join(appDir, "platform.app.json"), root);
    expect(result.lines[0]).toBe(`✔ apps/${ID}/platform.app.json: valid manifest for ${ID}@0.1.0`);
    expect(result.ok).toBe(true);
  });

  it("is picked up by `sync`: a launcher tile and a gateway site", async () => {
    const result = await sync(root, { check: false });
    expect(result.ok).toBe(true);
    const registry = JSON.parse(readFileSync(path.join(root, LAUNCHER_REGISTRY), "utf8")) as {
      apps: { key: string }[];
    };
    expect(registry.apps.map((a) => a.key)).toEqual([ID]);
    expect(readFileSync(path.join(root, GATEWAY_CADDYFILE), "utf8")).toContain(`${ID}.localhost`);
    expect((await sync(root, { check: true })).ok).toBe(true);
  });

  describe.skipIf(!existsSync(donor))("with its dependencies linked in", () => {
    beforeAll(() => symlinkSync(donor, path.join(appDir, "node_modules"), "dir"));

    it("has a platform.app.json that is exactly what `manifest compile` makes of platform.app.ts", async () => {
      const written = JSON.parse(readFileSync(path.join(appDir, "platform.app.json"), "utf8"));
      const result = await compileCommand(path.join(appDir, "platform.app.ts"), root);
      expect(result.ok, result.lines.join("\n")).toBe(true);
      expect(JSON.parse(readFileSync(path.join(appDir, "platform.app.json"), "utf8"))).toEqual(written);
    });

    it("typechecks", () => {
      const { status, output } = run("typescript/bin/tsc", ["--noEmit"]);
      expect(output).toBe("");
      expect(status).toBe(0);
    }, 120_000);

    it("lints clean", () => {
      const { status, output } = run("eslint/bin/eslint.js", ["."]);
      expect(output).toBe("");
      expect(status).toBe(0);
    }, 120_000);

    it("passes its own test", () => {
      const { status, output } = run("vitest/vitest.mjs", ["run"]);
      expect(output).toContain("2 passed");
      expect(status).toBe(0);
    }, 120_000);
  });
});
