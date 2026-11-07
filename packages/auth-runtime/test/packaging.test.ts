/**
 * Publishable by construction (S3 will publish; S2 must not block it) and framework-free: builds the package into a
 * scratch directory and inspects what a consumer would get. A clean external install is S3's proof, not this test's.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "node_modules", ".cache", `pkg-test-${process.pid}`);
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  private?: boolean;
  version: string;
  name: string;
  license?: string;
  engines?: Record<string, string>;
  type?: string;
  files?: string[];
  publishConfig?: unknown;
  scripts: Record<string, string>;
  exports: Record<string, { types: string; default: string }>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const specifiers = (file: string): string[] => {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
};
const external = (s: string) =>
  s.startsWith(".")
    ? null
    : s.startsWith("node:")
      ? null
      : s.startsWith("@")
        ? s.split("/").slice(0, 2).join("/")
        : s.split("/")[0]!;

beforeAll(() => {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  execFileSync(
    process.execPath,
    [
      path.join(root, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      path.join(root, "tsconfig.build.json"),
      "--outDir",
      out,
    ],
    { cwd: root, stdio: "pipe" },
  );
});
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("packaging: the built package", () => {
  it("is private at 0.1.0 with no registry or publish configuration (publishing is S3)", () => {
    expect(manifest.name).toBe("@asafarim/auth-runtime");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.private).toBe(true);
    expect(manifest.publishConfig).toBeUndefined();
    expect(manifest.scripts.publish).toBeUndefined();
    expect(manifest.scripts.prepublishOnly).toBeUndefined();
  });

  it("has what a publish needs: license, files, engines, type, exports with types for every subpath", () => {
    expect(manifest.license).toBeTruthy();
    expect(manifest.files).toEqual(["dist"]);
    expect(manifest.engines?.node).toMatch(/24/);
    expect(manifest.type).toBe("module");
    expect(Object.keys(manifest.exports).sort()).toEqual([
      ".",
      "./authjs",
      "./node",
      "./oidc",
      "./session",
      "./stores/memory",
      "./stores/redis",
    ]);
    for (const [sub, e] of Object.entries(manifest.exports)) {
      expect(existsSync(path.join(out, e.default.replace("./dist/", ""))), `${sub} default`).toBe(true);
      expect(existsSync(path.join(out, e.types.replace("./dist/", ""))), `${sub} types`).toBe(true);
    }
  });

  it("depends on nothing in the workspace: no workspace: protocol in anything a consumer installs", () => {
    for (const field of [manifest.dependencies, manifest.peerDependencies ?? {}, manifest.optionalDependencies ?? {}])
      for (const [name, range] of Object.entries(field)) expect(range, name).not.toMatch(/^workspace:|^file:|^link:/);
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["jose", "openid-client"]);
  });

  it("ships no source path, no .ts specifier and no import that leaves the package", () => {
    const files = walk(out).filter((f) => /\.(js|d\.ts)$/.test(f));
    expect(files.length).toBeGreaterThan(10);
    expect(walk(out).filter((f) => f.endsWith(".map"))).toEqual([]);
    for (const f of files) {
      for (const s of specifiers(f)) {
        expect(s, `${path.relative(out, f)} → ${s}`).not.toMatch(/\.ts$|\/src\/|^\.\.\/\.\./);
        if (s.startsWith(".")) expect(path.resolve(path.dirname(f), s).startsWith(out), `${f} → ${s}`).toBe(true);
      }
      // No machine path, and no source map pointing back at src/ (the maps are not shipped, so they would dangle).
      expect(readFileSync(f, "utf8"), f).not.toMatch(/\/home\/|sourceMappingURL/);
    }
  });

  it("imports only node: built-ins, jose and openid-client: no React, Next, Auth.js, @asafarim/* or app code", () => {
    const externals = new Set<string>();
    for (const f of walk(out).filter((x) => x.endsWith(".js")))
      for (const s of specifiers(f)) if (external(s)) externals.add(external(s)!);
    expect([...externals].sort()).toEqual(["jose", "openid-client"]);
  });

  it("each subpath's closure is as small as documented (core, session, authjs and the stores need no OIDC library)", () => {
    const closure = (entry: string): string[] => {
      const seen = new Set<string>();
      const ext = new Set<string>();
      const visit = (f: string) => {
        if (seen.has(f)) return;
        seen.add(f);
        for (const s of specifiers(f)) {
          const e = external(s);
          if (e) ext.add(e);
          else if (s.startsWith(".")) visit(path.resolve(path.dirname(f), s));
        }
      };
      visit(path.join(out, entry));
      return [...ext].sort();
    };
    expect(closure("index.js")).toEqual([]);
    expect(closure("session.js")).toEqual([]);
    expect(closure("authjs.js")).toEqual([]);
    expect(closure("stores/memory.js")).toEqual([]);
    expect(closure("stores/redis.js")).toEqual([]);
    expect(closure("oidc.js")).toEqual(["jose", "openid-client"]);
    expect(closure("node.js")).toEqual(["jose", "openid-client"]);
  });

  it("every subpath loads in plain Node and exposes its documented API", async () => {
    const load = (f: string) => import(pathToFileURL(path.join(out, f)).href) as Promise<Record<string, unknown>>;
    const expectations: Record<string, string[]> = {
      "index.js": ["AuthRuntimeError", "resolveBounds", "validateReturnTarget", "readCookie", "endSessionUrl"],
      "oidc.js": ["createOidcClient"],
      "session.js": ["createSessionRuntime"],
      "node.js": ["createNodeAuth", "createSessionStateHandler"],
      "authjs.js": [
        "asafarimAuthConfig",
        "SESSION_COOKIE_NAME",
        "IDENTITY_SESSION_SECONDS",
        "withForwardedOrigin",
        "visitorOrigin",
        "endSessionUrl",
        "forwardedOrigin",
      ],
      "stores/memory.js": ["createMemoryStore"],
      "stores/redis.js": ["createRedisStore"],
    };
    for (const [file, names] of Object.entries(expectations)) {
      const mod = await load(file);
      for (const n of names) expect(typeof mod[n], `${file} ${n}`).not.toBe("undefined");
    }
  });
});
