import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  exportedMethods,
  globRegex,
  localImports,
  mentionsKey,
  resolveImport,
  reviewCommand,
  routeUrl,
  samplePaths,
  sourceFiles,
} from "./review.ts";
import { scaffoldApp } from "./scaffold.ts";

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "review-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(rel: string, content: string) {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A valid manifest for app `shop`, with overrides. */
function manifest(over: Record<string, unknown> = {}) {
  return {
    id: "shop",
    name: "Shop",
    version: "0.1.0",
    platform: ">=0.1 <1",
    owner: "ASafariM Digital",
    runtime: {
      image: "shop",
      port: 3000,
      health: { live: "/api/health", ready: "/api/health" },
      resources: { memory: "128m", cpus: 0.25 },
    },
    database: { engine: "none" },
    auth: { client: "oidc", publicPaths: ["/api/health"] },
    permissions: [
      { key: "shop.orders.read", description: "See orders" },
      { key: "shop.orders.write", description: "Change orders" },
    ],
    roles: [],
    ui: { glyph: "SH", color: "#2563eb", nav: [], status: "active" },
    ...over,
  };
}

function writeApp(m: Record<string, unknown>) {
  put("apps/shop/platform.app.json", JSON.stringify(m));
}

const review = (args: string[] = []) => reviewCommand([...args, "--root", root], root, () => root)!;
const json = (args: string[] = []) => {
  const out = review([...args, "--json"]);
  return {
    ok: out.ok,
    ...(JSON.parse(out.lines[0]!) as {
      reviews: { app: string; findings: { kind: string; subject: string }[] }[];
      errors: string[];
    }),
  };
};
const kinds = (args: string[] = []) =>
  json(args).reviews.flatMap((r) => r.findings.map((f) => `${f.kind} ${f.subject}`));

describe("helpers", () => {
  it("maps route files to URLs, dropping route groups and slots", () => {
    expect(routeUrl("app/api/orders/route.ts")).toBe("/api/orders");
    expect(routeUrl("app/(shop)/@modal/api/orders/[id]/route.ts")).toBe("/api/orders/[id]");
    expect(routeUrl("app/route.ts")).toBe("/");
    expect(routeUrl("app/api/orders/page.tsx")).toBeUndefined();
    expect(routeUrl("lib/route.ts")).toBeUndefined();
  });

  it("turns dynamic segments into sample paths", () => {
    expect(samplePaths("/a/[id]")).toEqual(["/a/x"]);
    expect(samplePaths("/a/[...p]")).toEqual(["/a/x", "/a/x/y"]);
    expect(samplePaths("/a/[[...p]]")).toEqual(["/a", "/a/x", "/a/x/y"]);
  });

  it("matches globs like the gateway: * is one segment, ** any depth and the bare folder", () => {
    expect(globRegex("/api/*").test("/api/x")).toBe(true);
    expect(globRegex("/api/*").test("/api/x/y")).toBe(false);
    expect(globRegex("/api/**").test("/api")).toBe(true);
    expect(globRegex("/api/**").test("/api/x/y")).toBe(true);
    expect(globRegex("/api.v1").test("/apixv1")).toBe(false);
  });

  it("finds exported HTTP methods in every export form", () => {
    expect(
      exportedMethods("export async function GET() {}\nexport const POST = h;\nexport { PATCH, DELETE as X }"),
    ).toEqual(["GET", "POST", "PATCH", "DELETE"]);
    expect(exportedMethods("function GET() {}\nexport const dynamic = 1;")).toEqual([]);
  });

  it("matches a permission only as a whole string literal", () => {
    expect(mentionsKey(`gate("shop.orders.read")`, "shop.orders.read")).toBe(true);
    expect(mentionsKey("gate('shop.orders.read')", "shop.orders.read")).toBe(true);
    expect(mentionsKey("gate(`shop.orders.read`)", "shop.orders.read")).toBe(true);
    expect(mentionsKey(`gate("shop.orders.readx")`, "shop.orders.read")).toBe(false);
    expect(mentionsKey(`// shop.orders.read`, "shop.orders.read")).toBe(false);
  });

  it("resolves the app's own imports and ignores packages", () => {
    const known = new Set(["lib/gate.ts", "lib/api/index.ts", "app/api/x/helper.tsx"]);
    expect(localImports(`import { a } from "@/lib/gate";\nimport b from "./helper";\nimport z from "zod";`)).toEqual([
      "@/lib/gate",
      "./helper",
    ]);
    expect(resolveImport("app/api/x/route.ts", "@/lib/gate", known)).toBe("lib/gate.ts");
    expect(resolveImport("app/api/x/route.ts", "@/lib/api", known)).toBe("lib/api/index.ts");
    expect(resolveImport("app/api/x/route.ts", "./helper.js", known)).toBe("app/api/x/helper.tsx");
    expect(resolveImport("app/api/x/route.ts", "../../../../outside", known)).toBeUndefined();
  });

  it("reads runtime source only: no tests, e2e, fixtures, node_modules or the manifest", () => {
    put("apps/shop/platform.app.ts", "x");
    put("apps/shop/lib/a.ts", "x");
    put("apps/shop/lib/a.test.ts", "x");
    put("apps/shop/lib/types.d.ts", "x");
    put("apps/shop/e2e/b.spec.ts", "x");
    put("apps/shop/test/c.ts", "x");
    put("apps/shop/node_modules/p/index.js", "x");
    put("apps/shop/.next/server.js", "x");
    put("apps/shop/app/page.tsx", "x");
    expect(sourceFiles(path.join(root, "apps/shop"))).toEqual(["app/page.tsx", "lib/a.ts"]);
  });
});

describe("platform manifest review", () => {
  it("reports nothing for an app whose code matches its manifest", () => {
    writeApp(
      manifest({
        routes: [
          { path: "/api/orders", methods: ["GET"], permission: "shop.orders.read" },
          { path: "/internal/**", expose: false },
        ],
        events: { publishes: [{ type: "shop.order.placed.v1", schema: "./events/placed.json" }] },
      }),
    );
    put("apps/shop/events/placed.json", JSON.stringify({ type: "object" }));
    put("apps/shop/app/api/health/route.ts", "export function GET() {}");
    put("apps/shop/app/internal/ping/route.ts", "export function GET() {}");
    put("apps/shop/app/api/orders/route.ts", "export function GET() {}");
    put(
      "apps/shop/app/api/orders/[id]/route.ts",
      `import { check } from "@/lib/access";\nexport async function PATCH() { await check(); }`,
    );
    put(
      "apps/shop/lib/access.ts",
      `import { gate } from "./gate";\nexport const check = () => gate("shop.orders.write");`,
    );
    put("apps/shop/lib/gate.ts", "export const gate = (p: string) => p;");
    put("apps/shop/app/api/auth/[...nextauth]/route.ts", "export const GET = h; export const POST = h;");
    put("apps/shop/app/api/session/route.ts", "export const GET = createSessionHandler({});");
    const out = review();
    expect(out.ok).toBe(true);
    expect(out.lines).toContain("✔ shop: 0 finding(s); 6 route handler(s), 2 sign-in plumbing");
    expect(out.lines.at(-1)).toBe("Manifest review: nothing to report.");
  });

  it("reports a missing or broken event schema", () => {
    writeApp(
      manifest({
        events: {
          publishes: [
            { type: "shop.order.placed.v1", schema: "./events/placed.json" },
            { type: "shop.order.paid.v1", schema: "./events/paid.json" },
            { type: "shop.order.sent.v1", schema: "./events/sent.json" },
            { type: "shop.order.lost.v1", schema: "./events/lost.json" },
          ],
        },
      }),
    );
    put("apps/shop/events/paid.json", "{ nope");
    put("apps/shop/events/sent.json", "[1]");
    mkdirSync(path.join(root, "apps/shop/events/lost.json"), { recursive: true }); // a folder, not a file
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    expect(kinds()).toEqual([
      "event-schema-missing shop.order.placed.v1",
      "event-schema-invalid shop.order.paid.v1",
      "event-schema-invalid shop.order.sent.v1",
      "event-schema-missing shop.order.lost.v1",
    ]);
  });

  it("reports a permission nothing asks for; a gateway route or a test doesn't count as code, but a route does count", () => {
    writeApp(manifest({ routes: [{ path: "/api/orders", permission: "shop.orders.write" }] }));
    put("apps/shop/lib/x.test.ts", `gate("shop.orders.read")`);
    expect(kinds()).toEqual(["permission-never-checked shop.orders.read"]);
  });

  it("reports handlers that nothing guards, per method, and accepts method-scoped routes", () => {
    writeApp(manifest({ routes: [{ path: "/api/orders/**", methods: ["GET"], permission: "shop.orders.read" }] }));
    put("apps/shop/lib/x.ts", `"shop.orders.write"`);
    put("apps/shop/app/api/orders/[id]/route.ts", "export function GET() {}\nexport function DELETE() {}");
    put("apps/shop/app/api/admin/route.ts", `import { db } from "@/lib/db";\nexport const POST = () => db();`);
    put("apps/shop/lib/db.ts", "export const db = () => 1;");
    expect(kinds()).toEqual(["route-unguarded POST /api/admin", "route-unguarded DELETE /api/orders/[id]"]);
  });

  it("guards a catch-all only when every depth is covered", () => {
    writeApp(manifest({ routes: [{ path: "/files/*", permission: "shop.orders.read" }] }));
    put("apps/shop/lib/x.ts", `"shop.orders.write"`);
    put("apps/shop/app/files/[...p]/route.ts", "export function GET() {}");
    expect(kinds()).toEqual(["route-unguarded GET /files/[...p]"]);
  });

  it("is advisory unless --strict", () => {
    writeApp(manifest());
    expect(review().ok).toBe(true);
    const strict = review(["--strict"]);
    expect(strict.ok).toBe(false);
    expect(strict.lines.at(-1)).toMatch(/2 finding\(s\).*--strict: failing/);
  });

  it("reviews only the named apps and refuses unknown ones", () => {
    writeApp(manifest());
    put(
      "apps/other/platform.app.json",
      JSON.stringify({
        ...manifest({ id: "other", permissions: [] }),
        runtime: { ...manifest().runtime, image: "other" },
      }),
    );
    expect(json(["other"]).reviews.map((r) => r.app)).toEqual(["other"]);
    expect(json().reviews.map((r) => r.app)).toEqual(["other", "shop"]);
    const missing = review(["nope"]);
    expect(missing.ok).toBe(false);
    expect(missing.lines[0]).toMatch(/no apps\/<id>\/platform\.app\.json for: nope/);
  });

  it("fails on an invalid manifest without reviewing it", () => {
    put("apps/shop/platform.app.json", JSON.stringify({ id: "shop" }));
    const out = review();
    expect(out.ok).toBe(false);
    expect(out.lines[0]).toMatch(/not a valid manifest/);
  });

  it("rejects unknown flags", () => {
    expect(reviewCommand(["--fix"], root, () => root)).toBeNull();
    expect(reviewCommand(["--root"], root, () => root)).toBeNull();
    expect(reviewCommand(["--root", "--json"], root, () => root)).toBeNull();
  });

  it("in a freshly scaffolded app, finds only the placeholder permission the template never checks", () => {
    expect(scaffoldApp(root, { id: "fresh" }).ok).toBe(true);
    expect(kinds(["fresh"])).toEqual(["permission-never-checked fresh.read"]);
  });

  it("finds nothing in this workspace's own apps", () => {
    const out = reviewCommand(["--json"], WORKSPACE, () => WORKSPACE)!;
    const { reviews } = JSON.parse(out.lines[0]!) as { reviews: { app: string; findings: unknown[] }[] };
    expect(reviews.map((r) => r.app)).toEqual(expect.arrayContaining(["docs", "notes"]));
    expect(reviews.flatMap((r) => r.findings)).toEqual([]);
  });
});
