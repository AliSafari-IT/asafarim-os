import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateManifest } from "@asafarim/app-manifest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TEMPLATE_DIR,
  defaultGlyph,
  defaultName,
  newAppCommand,
  nextDevPort,
  renderApp,
  renderTemplate,
  scaffoldApp,
  type ScaffoldIo,
} from "./scaffold.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "scaffold-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Every file and folder under `dir` (relative), so "nothing was written" can be asserted exactly. */
function tree(dir = root): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

/** Only the files under `dir` (relative). */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
    .sort();
}

describe("scaffoldApp", () => {
  it("writes the app to apps/<id>/ and its manifest validates against the schema", () => {
    const result = scaffoldApp(root, { id: "demo-hello" });
    expect(result.ok).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(root, "apps/demo-hello/platform.app.json"), "utf8"));
    expect(validateManifest(manifest)).toMatchObject({ ok: true });
    expect(manifest).toMatchObject({
      id: "demo-hello",
      name: "Demo Hello",
      ui: { glyph: "DH", launcher: { access: "authenticated" } },
      runtime: { health: { live: "/health/live", ready: "/health/ready" } },
    });
    expect(manifest.permissions).toHaveLength(1);
    expect(manifest.roles).toHaveLength(1);
  });

  it("writes the pieces the issue lists", () => {
    scaffoldApp(root, { id: "demo-hello" });
    const written = files(path.join(root, "apps/demo-hello"));
    for (const expected of [
      "package.json",
      "tsconfig.json",
      "next.config.ts",
      "eslint.config.mjs",
      "vitest.config.ts",
      "platform.app.ts",
      "platform.app.json",
      "instrumentation.ts",
      "README.md",
      "app/page.tsx",
      "app/health/live/route.ts",
      "app/health/ready/route.ts",
      "test/manifest.test.ts",
    ]) {
      expect(written).toContain(expected);
    }
    expect(written).toContain("app/api/auth/[...nextauth]/route.ts");
    expect(written.some((f) => f.endsWith(".tmpl"))).toBe(false);
  });

  it("uses --name, the app's launcher uses the SDK, and telemetry starts on boot", () => {
    scaffoldApp(root, { id: "demo-hello", name: "Hello Demo" });
    const read = (f: string) => readFileSync(path.join(root, "apps/demo-hello", f), "utf8");
    expect(JSON.parse(read("platform.app.json")).name).toBe("Hello Demo");
    expect(read("app/page.tsx")).toContain('from "@asafarim/app-sdk/react"');
    expect(read("app/page.tsx")).toContain('current="demo-hello"');
    expect(read("instrumentation.ts")).toContain(
      "registerTelemetry({ appId: manifest.id, version: manifest.version })",
    );
  });

  it("leaves no placeholder behind in any file", () => {
    scaffoldApp(root, { id: "demo-hello" });
    const dir = path.join(root, "apps/demo-hello");
    for (const rel of files(dir)) {
      expect(readFileSync(path.join(dir, rel), "utf8"), rel).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  it.each([
    ["an upper-case id", "Demo"],
    ["a path", "../etc"],
    ["a slash", "a/b"],
    ["spaces", "my app"],
    ["an empty id", ""],
    ["a double dash", "a--b"],
    ["a leading digit", "1app"],
    ["a single character", "x"],
    ["33 characters", "a".repeat(33)],
  ])("refuses %s and writes nothing", (_what, id) => {
    const result = scaffoldApp(root, { id });
    expect(result.ok).toBe(false);
    expect(result.lines.at(-1)).toBe("Nothing was written.");
    expect(tree()).toEqual([]);
  });

  it.each(["admin", "core", "platform", "identity", "www"])("refuses the reserved id %s", (id) => {
    const result = scaffoldApp(root, { id });
    expect(result).toMatchObject({ ok: false });
    expect(result.lines.join("\n")).toContain("reserved");
    expect(tree()).toEqual([]);
  });

  it.each([
    ["apps", "an app in apps/"],
    ["external-apps", "an app in external-apps/"],
    ["core", "a core service"],
  ])("refuses an id that already exists in %s/", (dir, what) => {
    mkdirSync(path.join(root, dir, "taken"), { recursive: true });
    const before = tree();
    const result = scaffoldApp(root, { id: "taken" });
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain(what);
    expect(tree()).toEqual(before);
  });

  it.each(["", "<b>", 'say "hi"', "a{{id}}", "back\\slash", "x".repeat(65), " leading", "tab\tname"])(
    "refuses the display name %j",
    (name) => {
      const result = scaffoldApp(root, { id: "demo-hello", name });
      expect(result.ok).toBe(false);
      expect(tree()).toEqual([]);
    },
  );

  it("accepts a display name with letters from other scripts, digits, dots and dashes", () => {
    expect(scaffoldApp(root, { id: "demo-hello", name: "Café 2.0 - Édition" }).ok).toBe(true);
  });

  it("is never partial: a failing write leaves neither the app nor the folders it created", () => {
    let writes = 0;
    const io: ScaffoldIo = {
      mkdir: (dir) => void mkdirSync(dir, { recursive: true }),
      write: (file, content) => {
        if (++writes === 5) throw new Error("disk full");
        writeFileSync(file, content);
      },
      rename: () => undefined,
      remove: (target) => rmSync(target, { recursive: true, force: true }),
    };
    const result = scaffoldApp(root, { id: "demo-hello" }, io);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("disk full");
    expect(tree()).toEqual([]);
  });

  it("keeps an apps/ folder that was already there when a write fails", () => {
    mkdirSync(path.join(root, "apps/other"), { recursive: true });
    const io: ScaffoldIo = {
      mkdir: (dir) => void mkdirSync(dir, { recursive: true }),
      write: () => {
        throw new Error("nope");
      },
      rename: () => undefined,
      remove: (target) => rmSync(target, { recursive: true, force: true }),
    };
    expect(scaffoldApp(root, { id: "demo-hello" }, io).ok).toBe(false);
    expect(tree()).toEqual(["apps", "apps/other"]);
  });

  it("does not touch an existing app when asked for the same id twice", () => {
    expect(scaffoldApp(root, { id: "demo-hello" }).ok).toBe(true);
    const before = readFileSync(path.join(root, "apps/demo-hello/platform.app.json"), "utf8");
    expect(scaffoldApp(root, { id: "demo-hello", name: "Other" }).ok).toBe(false);
    expect(readFileSync(path.join(root, "apps/demo-hello/platform.app.json"), "utf8")).toBe(before);
  });
});

describe("helpers", () => {
  it("names and abbreviates an id", () => {
    expect(defaultName("demo-hello")).toBe("Demo Hello");
    expect(defaultName("tasks")).toBe("Tasks");
    expect(defaultGlyph("demo-hello")).toBe("DH");
    expect(defaultGlyph("tasks")).toBe("TA");
    expect(defaultGlyph("my-big-app-x")).toBe("MBA");
  });

  it("picks the next free dev port from the apps that exist", () => {
    expect(nextDevPort(root)).toBe(4120);
    for (const [id, port] of [
      ["notes", 4100],
      ["docs", 4110],
    ] as const) {
      mkdirSync(path.join(root, "apps", id), { recursive: true });
      writeFileSync(
        path.join(root, "apps", id, "package.json"),
        JSON.stringify({ scripts: { dev: `next dev --port ${port}`, start: `next start --port ${port}` } }),
      );
    }
    mkdirSync(path.join(root, "apps/no-package"));
    expect(nextDevPort(root)).toBe(4120);
    scaffoldApp(root, { id: "first" });
    expect(nextDevPort(root)).toBe(4130);
  });

  it("replaces placeholders and refuses one it has no value for", () => {
    expect(renderTemplate("{{id}}-{{id}}", { id: "a" })).toBe("a-a");
    expect(() => renderTemplate("{{nope}}", { id: "a" })).toThrow("unknown placeholder {{nope}}");
  });

  it("renders every template file with only the known placeholders", () => {
    const rendered = renderApp({ id: "demo-hello", name: "Demo Hello", glyph: "DH", port: "4120" }, TEMPLATE_DIR);
    expect(rendered.length).toBeGreaterThan(15);
    expect(new Set(rendered.map(([f]) => f)).size).toBe(rendered.length);
  });
});

describe("newAppCommand", () => {
  it("scaffolds into --root, resolved against the working directory", () => {
    const result = newAppCommand(["demo-hello", "--name", "Hello Demo", "--root", "sub"], root, () => "unused");
    expect(result?.ok).toBe(true);
    expect(JSON.parse(readFileSync(path.join(root, "sub/apps/demo-hello/platform.app.json"), "utf8")).name).toBe(
      "Hello Demo",
    );
  });

  it("uses the workspace root when --root is not given", () => {
    expect(newAppCommand(["demo-hello"], "/elsewhere", () => root)?.ok).toBe(true);
    expect(tree()).toContain("apps/demo-hello/platform.app.json");
  });

  it.each([[[]], [["--name", "x"]], [["demo", "--bogus"]], [["demo", "--name"]], [["demo", "extra"]]])(
    "returns null (usage) for %j",
    (args) => {
      expect(newAppCommand(args, root, () => root)).toBeNull();
      expect(tree()).toEqual([]);
    },
  );
});
