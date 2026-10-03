import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileCommand, validateCommand } from "./manifest.ts";

const fixtures = path.resolve(import.meta.dirname, "..", "..", "..", "packages", "app-manifest", "fixtures");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "platform-manifest-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("platform manifest validate", () => {
  it("accepts a valid JSON manifest and summarises it", async () => {
    const result = await validateCommand(path.join(fixtures, "testora.platform.app.json"), fixtures);
    expect(result.ok).toBe(true);
    expect(result.lines[0]).toBe("✔ testora.platform.app.json: valid manifest for testora@1.8.0");
    expect(result.lines[1]).toContain("4 permission(s), 3 role(s), 3 route(s)");
  });

  it("lists every problem with its field path", async () => {
    const result = await validateCommand(path.join(fixtures, "invalid.platform.app.json"), fixtures);
    expect(result.ok).toBe(false);
    const text = result.lines.join("\n");
    expect(text).toMatch(/^✖ invalid\.platform\.app\.json: \d+ problem\(s\)/);
    expect(text).toContain('  - roles[0].grants[1]: grants "hub.users.manage", outside the app\'s own namespace');
    expect(text).toContain("  - secrets[1]: looks like a secret value");
  });

  it("loads a TypeScript manifest's default export", async () => {
    const file = path.join(dir, "platform.app.ts");
    const json = readFileSync(path.join(fixtures, "minimal.platform.app.json"), "utf8");
    writeFileSync(file, `export default ${json};\n`);
    const result = await validateCommand(file, dir);
    expect(result.ok).toBe(true);
    expect(result.lines[0]).toBe("✔ platform.app.ts: valid manifest for notes@0.1.0");
  });

  it("reports an unreadable file instead of crashing", async () => {
    const file = path.join(dir, "broken.json");
    writeFileSync(file, "{ not json");
    const result = await validateCommand(file, dir);
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toMatch(/^✖ broken\.json: can't read the manifest/);
  });
});

describe("platform manifest compile", () => {
  it("writes platform.app.json next to the source", async () => {
    const file = path.join(dir, "platform.app.ts");
    writeFileSync(file, `export default ${readFileSync(path.join(fixtures, "minimal.platform.app.json"), "utf8")};\n`);
    const result = await compileCommand(file, dir);
    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(path.join(dir, "platform.app.json"), "utf8")) as { id: string };
    expect(written.id).toBe("notes");
  });
});
