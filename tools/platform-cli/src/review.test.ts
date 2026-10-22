import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkedKeysIn,
  exportedMethods,
  globRegex,
  globSamples,
  localImports,
  MARKDOWN_CLEAN_MARKER,
  MARKDOWN_MARKER,
  markdownCell,
  mentionsKey,
  mentionsName,
  renderMarkdown,
  eventTypesIn,
  resolveImport,
  reviewCommand,
  blankStrings,
  compareRouteSpecificity,
  configReadsIn,
  readsAllConfig,
  pageUrl,
  routeUrl,
  stringLiterals,
  routeUrlRegex,
  samplePaths,
  sourceFiles,
  stripComments,
  type AppReview,
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
    roles: [{ key: "shop.staff", grants: ["shop.orders.read", "shop.orders.write"], description: "Staff" }],
    ui: { glyph: "SH", color: "#2563eb", nav: [], status: "active" },
    ...over,
  };
}

/** Writes the manifest, and the `/api/health` route `manifest()` declares as its health paths. */
function writeApp(m: Record<string, unknown>) {
  put("apps/shop/platform.app.json", JSON.stringify(m));
  put("apps/shop/app/api/health/route.ts", "export function GET() {}");
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
  it("reads whole string literals only: not quotes inside another literal, not comments", () => {
    const text = `a("x.y"); b('say "q.r" now'); c(\`t\\\`u\`); // "c.d"\n/* 'e.f' */ d("")`;
    expect([...stringLiterals(text)]).toEqual(["x.y", 'say "q.r" now', "t\\`u", ""]);
  });

  it("ranks matching route URLs the way Next.js picks one: static, dynamic, catch-all, optional catch-all", () => {
    const urls = ["/[[...all]]", "/status/[probe]", "/[...rest]", "/status/ready", "/[a]/ready"];
    expect([...urls].sort(compareRouteSpecificity)).toEqual([
      "/status/ready",
      "/status/[probe]",
      "/[a]/ready",
      "/[...rest]",
      "/[[...all]]",
    ]);
  });

  it("maps route files to URLs, dropping route groups and slots", () => {
    expect(routeUrl("app/api/orders/route.ts")).toBe("/api/orders");
    expect(routeUrl("app/(shop)/@modal/api/orders/[id]/route.ts")).toBe("/api/orders/[id]");
    expect(routeUrl("app/route.ts")).toBe("/");
    expect(routeUrl("app/api/orders/page.tsx")).toBeUndefined();
    expect(routeUrl("lib/route.ts")).toBeUndefined();
  });

  it("maps page files to URLs and turns globs into sample paths", () => {
    expect(pageUrl("app/(site)/admin/[id]/page.tsx")).toBe("/admin/[id]");
    expect(pageUrl("app/page.tsx")).toBe("/");
    expect(pageUrl("app/api/orders/route.ts")).toBeUndefined();
    expect(globSamples("/api/orders")).toEqual(["/api/orders"]);
    expect(globSamples("/api/*/items")).toEqual(["/api/x/items"]);
    expect(globSamples("/api/**")).toEqual(["/api", "/api/x"]);
    expect(globSamples("/**")).toEqual(["/", "/x"]);
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
      exportedMethods(
        "export async function GET() {}\nexport const POST = h;\nexport { PATCH, DELETE as X, handler as PUT }",
      ),
    ).toEqual(["GET", "POST", "PUT", "PATCH"]);
    expect(exportedMethods("function GET() {}\nexport const dynamic = 1;")).toEqual([]);
  });

  it("matches a permission only as a whole string literal", () => {
    expect(mentionsKey(`gate("shop.orders.read")`, "shop.orders.read")).toBe(true);
    expect(mentionsKey("gate('shop.orders.read')", "shop.orders.read")).toBe(true);
    expect(mentionsKey("gate(`shop.orders.read`)", "shop.orders.read")).toBe(true);
    expect(mentionsKey(`gate("shop.orders.readx")`, "shop.orders.read")).toBe(false);
    expect(mentionsKey(`// shop.orders.read`, "shop.orders.read")).toBe(false);
  });

  it("matches route URLs against concrete paths, dynamic segments included", () => {
    expect(routeUrlRegex("/events/placed").test("/events/placed")).toBe(true);
    expect(routeUrlRegex("/events/placed").test("/events/placedx")).toBe(false);
    expect(routeUrlRegex("/events/[kind]").test("/events/placed")).toBe(true);
    expect(routeUrlRegex("/events/[kind]").test("/events/a/b")).toBe(false);
    expect(routeUrlRegex("/events/[...p]").test("/events/a/b")).toBe(true);
    expect(routeUrlRegex("/events/[...p]").test("/events")).toBe(false);
    expect(routeUrlRegex("/events/[[...p]]").test("/events")).toBe(true);
    expect(routeUrlRegex("/").test("/")).toBe(true);
  });

  it("finds event types in the app's own namespace, as whole string literals only", () => {
    const text = `publish("shop.order.placed.v1"); x = 'shop.order.paid.v2'; y = \`other.order.placed.v1\`;
      import s from "./events/shop.order.sent.v1.json"; // shop.order.lost.v1
      z = "shop.orders.read"; w = "shop.order.placed.v1";`;
    expect(eventTypesIn(text, "shop")).toEqual(["shop.order.placed.v1", "shop.order.paid.v2"]);
    expect(eventTypesIn(`"my-app.item.made.v1"`, "my-app")).toEqual(["my-app.item.made.v1"]);
  });

  it("finds keys the code passes to a permission check in its own namespace", () => {
    const text = `await gate("shop.orders.wrte"); access.require(subject, 'shop.orders.read', { token });
      perms.includes(\`shop.admin\`); roles.has("shop.manager"); can("other.orders.read");
      log("shop.orders.logged"); gate(\`shop.\${x}\`); gate("shop.order.placed.v1"); file.includes("shop.env");
      x.includes("shop.data.json"); host.includes("shop.asafarim.site"); gate("myshop.orders.read"); gate(name, "shop.orders.second", "shop.orders.third");
      gate("shop.orders.wrte"); enabledFeatures.includes("shop.beta"); flags.has("shop.dark");
      // gate("shop.in.line.comment")
      /* access.require(subject, "shop.in.block.comment") */ log("// not a comment", "shop.after.string");
      access.require(getSubject(req), "shop.nested.first"); access?.permissions?.includes("shop.optional");
      gate("shop.orders.v1"); userGrants.has("shop.granted");`;
    expect(checkedKeysIn(text, "shop")).toEqual([
      "shop.orders.wrte",
      "shop.orders.read",
      "shop.admin",
      "shop.manager",
      "shop.orders.second",
      "shop.nested.first",
      "shop.optional",
      "shop.orders.v1",
      "shop.granted",
    ]);
    expect(checkedKeysIn(`gate("my-app.items.read")`, "my-app")).toEqual(["my-app.items.read"]);
  });

  it("matches a secret name as a whole word in code, not in a comment or inside a longer name", () => {
    expect(mentionsName(`const t = process.env.SHOP_TOKEN;`, "SHOP_TOKEN")).toBe(true);
    expect(mentionsName(`const t = env["SHOP_TOKEN"];`, "SHOP_TOKEN")).toBe(true);
    expect(mentionsName(`const { SHOP_TOKEN } = process.env;`, "SHOP_TOKEN")).toBe(true);
    expect(mentionsName(`const t = process.env.SHOP_TOKEN_OLD;`, "SHOP_TOKEN")).toBe(false);
    expect(mentionsName(`const t = process.env.MY_SHOP_TOKEN;`, "SHOP_TOKEN")).toBe(false);
    expect(mentionsName(`const $SHOP_TOKEN = 1;`, "SHOP_TOKEN")).toBe(false);
    expect(mentionsName(`// reads SHOP_TOKEN\n/* SHOP_TOKEN */ const x = 1;`, "SHOP_TOKEN")).toBe(false);
  });

  it("finds config reads: a whole literal key on a config receiver, not in a comment or interpolated", () => {
    const text = `getPlatform().config.getInt("limits.max"); config.getString('source.repo');
      appConfig?.getBoolean(\`flags.dark\`); config . getNumber ( "rate.limit" );
      // config.getInt("in.comment")
      /* config.getString("in.block") */ params.getString("not.config"); getInt("bare.call");
      config.getString(\`source.\${x}\`); config.getString(name); config.getString("a", "b"); config.all();
      const help = 'call config.getInt("in.string") to read it'; log(\`config.getString("in.template")\`);
      config.getInt("limits.max");`;
    expect(configReadsIn(text)).toEqual([
      { getter: "getInt", key: "limits.max" },
      { getter: "getString", key: "source.repo" },
      { getter: "getBoolean", key: "flags.dark" },
      { getter: "getNumber", key: "rate.limit" },
      { getter: "getInt", key: "limits.max" },
    ]);
  });

  it("finds the SDK's every-key config read in code only", () => {
    expect(readsAllConfig(`const all = config.all();`)).toBe(true);
    expect(readsAllConfig(`getPlatform().config?.all()`)).toBe(true);
    expect(readsAllConfig(`appConfig . all ( )`)).toBe(true);
    expect(readsAllConfig(`// config.all()\n/* config.all() */ const x = 1;`)).toBe(false);
    expect(readsAllConfig(`log("config.all()"); items.all(); myconfigs.all;`)).toBe(false);
  });

  it("blanks comments but leaves strings, and keeps line breaks", () => {
    expect(stripComments(`a // b\nc /* d\ne */ f "g // h" 'i /* j */' \`k // l\``)).toBe(
      `a \nc     \n     f "g // h" 'i /* j */' \`k // l\``,
    );
    expect(stripComments(`x = "a\\"// b"; // c`)).toBe(`x = "a\\"// b"; \n`);
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

  it("blanks string contents but keeps quotes, length and line breaks", () => {
    const text = `a("bc", 'd\\'e', \`f\ng\`) // "h"`;
    const out = blankStrings(text);
    expect(out).toBe(`a("  ", '    ', \` \n \`) // " "`);
    expect(out).toHaveLength(text.length);
  });

  it("reads runtime source only: no tests, e2e, fixtures, node_modules or the manifest", () => {
    put("apps/shop/platform.app.ts", "x");
    put("apps/shop/lib/a.ts", "x");
    put("apps/shop/lib/a.test.ts", "x");
    put("apps/shop/lib/types.d.ts", "x");
    put("apps/shop/e2e/b.spec.ts", "x");
    put("apps/shop/test/c.ts", "x");
    put("apps/shop/tests/helper.ts", "x");
    put("apps/shop/lib/__tests__/d.ts", "x");
    put("apps/shop/node_modules/p/index.js", "x");
    put("apps/shop/.next/server.js", "x");
    put("apps/shop/app/page.tsx", "x");
    put("apps/shop/events/schema.js", "x"); // the schema folder at the root is skipped …
    put("apps/shop/app/events/paid/route.ts", "x"); // … but an events/ route folder is code
    expect(sourceFiles(path.join(root, "apps/shop"))).toEqual(["app/events/paid/route.ts", "app/page.tsx", "lib/a.ts"]);
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
    put("apps/shop/lib/events.ts", `export const PLACED = "shop.order.placed.v1";`);
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
    put(
      "apps/shop/lib/x.ts",
      `"shop.orders.read"; "shop.orders.write";
      ["shop.order.placed.v1", "shop.order.paid.v1", "shop.order.sent.v1", "shop.order.lost.v1"];`,
    );
    expect(kinds()).toEqual([
      "event-schema-missing shop.order.placed.v1",
      "event-schema-invalid shop.order.paid.v1",
      "event-schema-invalid shop.order.sent.v1",
      "event-schema-missing shop.order.lost.v1",
    ]);
  });

  it("reports a permission nothing asks for; a gateway route or a test doesn't count as code, but a route does count", () => {
    writeApp(manifest({ routes: [{ path: "/api/orders", permission: "shop.orders.write" }] }));
    put("apps/shop/app/api/orders/route.ts", "export function POST() {}");
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

  it("reports an event type the code names in its own namespace that the manifest doesn't publish", () => {
    writeApp(
      manifest({
        events: {
          publishes: [{ type: "shop.order.placed.v1", schema: "./events/placed.json" }],
          subscribes: [{ type: "billing.invoice.paid.v1", handler: "/events/invoice-paid" }],
        },
      }),
    );
    put("apps/shop/events/placed.json", JSON.stringify({ type: "object" }));
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    put(
      "apps/shop/lib/events.ts",
      `export const PLACED = "shop.order.placed.v1";\nexport const REFUNDED = "shop.order.refunded.v1";\nexport const PAID = "billing.invoice.paid.v1";`,
    );
    put("apps/shop/lib/more.ts", `send("shop.order.refunded.v1"); send("shop.cart.emptied.v1");`);
    put("apps/shop/lib/events.test.ts", `"shop.order.tested.v1"`);
    const found = json().reviews[0]!.findings as { kind: string; subject: string; file?: string }[];
    expect(found.map((f) => `${f.kind} ${f.subject} ${f.file}`)).toEqual([
      "event-not-declared shop.cart.emptied.v1 apps/shop/lib/more.ts",
      "event-not-declared shop.order.refunded.v1 apps/shop/lib/events.ts",
    ]);
  });

  it("reports a permission the code checks that the manifest declares neither as a permission nor a role", () => {
    writeApp(
      manifest({
        roles: [{ key: "shop.clerk", grants: ["shop.orders.read", "shop.orders.write"], description: "Clerk" }],
      }),
    );
    put("apps/shop/lib/gate.ts", `export async function gate(p: string) { return p; }`);
    put(
      "apps/shop/app/api/orders/route.ts",
      `import { gate } from "@/lib/gate";\nexport async function GET() { await gate("shop.orders.read"); }\nexport async function POST() { await gate("shop.orders.wrte"); }`,
    );
    put(
      "apps/shop/app/page.tsx",
      `const a = perms.includes("shop.orders.write"); const b = roles.includes("shop.clerk"); const c = roles.includes("shop.owner"); const d = perms.includes("shop.orders.wrte");`,
    );
    put("apps/shop/lib/other.ts", `log("shop.audit.read"); can("billing.invoices.read");`);
    put("apps/shop/lib/gate.test.ts", `gate("shop.tested.only")`);
    const found = json().reviews[0]!.findings as { kind: string; subject: string; file?: string }[];
    expect(found.map((f) => `${f.kind} ${f.subject} ${f.file}`)).toEqual([
      "permission-not-declared shop.orders.wrte apps/shop/app/api/orders/route.ts",
      "permission-not-declared shop.owner apps/shop/app/page.tsx",
    ]);
  });

  it("reports a declared secret no code reads, skipping names a framework reads by itself", () => {
    writeApp(
      manifest({
        secrets: [
          "SHOP_API_KEY",
          "SHOP_OLD_TOKEN",
          "SHOP_TEST_ONLY",
          "SHOP_COMMENTED",
          "AUTH_SECRET",
          "OTEL_HEADERS",
          "ASAFARIM_NATS_PASSWORD",
        ],
      }),
    );
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";\nexport const key = process.env.SHOP_API_KEY;`);
    put(
      "apps/shop/lib/note.ts",
      `// SHOP_COMMENTED used to be read here\nexport const t = process.env.SHOP_OLD_TOKEN_V2;`,
    );
    put("apps/shop/lib/x.test.ts", `process.env.SHOP_TEST_ONLY = "x";`);
    expect(kinds()).toEqual([
      "secret-never-read SHOP_COMMENTED",
      "secret-never-read SHOP_OLD_TOKEN",
      "secret-never-read SHOP_TEST_ONLY",
    ]);
    const text = review().lines.join("\n");
    expect(text).toMatch(/\[secret-never-read\] secret SHOP_OLD_TOKEN is declared/);
    const md = review(["--markdown"]).lines[0]!;
    expect(md).toContain("| secret-never-read | SHOP\\_OLD\\_TOKEN |");
  });

  it("reports a health path no route file answers with GET, once per path", () => {
    const health = (live: string, ready: string) =>
      manifest({
        runtime: { ...manifest().runtime, health: { live, ready } },
        auth: { client: "oidc", publicPaths: ["/api/health", "/status/*"] },
      });
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    // served by a static and by a dynamic route; /api/health comes from writeApp
    writeApp(health("/api/health", "/status/ready"));
    put("apps/shop/app/status/[probe]/route.ts", "export const GET = () => new Response();");
    expect(kinds()).toEqual([]);

    // a typo in both paths: one finding per distinct path, naming both probes when they share it
    writeApp(health("/api/healht", "/api/healht"));
    expect(kinds()).toEqual(["health-route-missing /api/healht"]);
    const found = json().reviews[0]!.findings as unknown as { message: string; file?: string }[];
    expect(found[0]!.message).toMatch(
      /^runtime\.health\.live and runtime\.health\.ready are \/api\/healht, but no route file serves it/,
    );
    expect(found[0]!.file).toBeUndefined();

    // a route that serves the path without GET, and a page (not a route handler) don't count
    writeApp(health("/api/health", "/ready"));
    put("apps/shop/app/api/health/route.ts", "export function POST() {}");
    put("apps/shop/app/ready/page.tsx", "export default function Page() { return null; }");
    const out = json();
    expect(out.reviews[0]!.findings.map((f) => `${f.kind} ${f.subject}`)).toEqual([
      "health-route-missing /api/health",
      "health-route-missing /ready",
    ]);
    const noGet = out.reviews[0]!.findings[0] as unknown as { message: string; file?: string };
    expect(noGet.file).toBe("apps/shop/app/api/health/route.ts");
    expect(noGet.message).toMatch(/^runtime\.health\.live is \/api\/health, but its route file doesn't export GET/);
    expect(review(["--markdown"]).lines[0]).toContain(
      "| health-route-missing | /ready |  | runtime.health.ready is /ready",
    );

    // the static route answers before the dynamic one, and a commented-out GET isn't an export
    writeApp(health("/api/health", "/status/ready"));
    put("apps/shop/app/status/[probe]/route.ts", "export const GET = () => new Response();");
    put("apps/shop/app/status/ready/route.ts", "// export function GET() {}\nexport function POST() {}");
    expect(kinds()).toEqual(["health-route-missing /status/ready"]);
    expect((json().reviews[0]!.findings[0] as { file?: string }).file).toBe("apps/shop/app/status/ready/route.ts");
  });

  it("reports config the code reads that the manifest doesn't declare, or declares with another type", () => {
    writeApp(
      manifest({
        config: [
          { key: "limits.max", type: "int", default: 10 },
          { key: "rate.factor", type: "number", default: 1.5 },
          { key: "source.repo", type: "string", default: "a/b" },
          { key: "flags.dark", type: "boolean", default: false },
        ],
      }),
    );
    put(
      "apps/shop/lib/x.ts",
      `"shop.orders.read"; "shop.orders.write";
      getPlatform().config.getInt("limits.max"); config.getNumber("limits.max"); config.getNumber("rate.factor");
      config.getString("source.repo"); config.getBoolean("flags.dark");`,
    );
    put(
      "apps/shop/app/page.tsx",
      `config.getInt("limits.maxx"); config.getInt("rate.factor"); config.getString("flags.dark");
      // config.getInt("only.in.comment")`,
    );
    put("apps/shop/lib/y.ts", `config.getInt("limits.maxx"); config.getBoolean("source.repo");`);
    put("apps/shop/lib/x.test.ts", `config.getInt("tested.only");`);
    const found = json().reviews[0]!.findings as { kind: string; subject: string; file?: string }[];
    expect(found.map((f) => `${f.kind} ${f.subject} ${f.file}`)).toEqual([
      "config-type-mismatch flags.dark apps/shop/app/page.tsx",
      "config-not-declared limits.maxx apps/shop/app/page.tsx",
      "config-type-mismatch rate.factor apps/shop/app/page.tsx",
      "config-type-mismatch source.repo apps/shop/lib/y.ts",
    ]);
    const text = review().lines.join("\n");
    expect(text).toMatch(/\[config-not-declared\] the code reads config limits\.maxx with getInt/);
    expect(text).toMatch(/\[config-type-mismatch\] .*declares it as number/);
    expect(review(["--markdown"]).lines[0]!).toContain("| config-not-declared | limits.maxx |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);
  });

  it("reports a declared config key no code reads, unless the code reads every key", () => {
    writeApp(
      manifest({
        config: [
          { key: "limits.max", type: "int", default: 10 },
          { key: "limits.old", type: "int", default: 5 },
          { key: "source.repo", type: "string", default: "a/b" },
          { key: "flags.commented", type: "boolean", default: false },
          { key: "flags.tested", type: "boolean", default: false },
        ],
      }),
    );
    put(
      "apps/shop/lib/x.ts",
      `"shop.orders.read"; "shop.orders.write";
      config.getInt("limits.max"); const REPO = "source.repo"; config.getString(REPO);
      config.getInt("limits.older");
      // config.getBoolean("flags.commented")`,
    );
    put("apps/shop/lib/x.test.ts", `config.getBoolean("flags.tested");`);
    const found = kinds().filter((k) => k.startsWith("config-never-read"));
    expect(found).toEqual([
      "config-never-read flags.commented",
      "config-never-read flags.tested",
      "config-never-read limits.old",
    ]);
    const text = review().lines.join("\n");
    expect(text).toMatch(/\[config-never-read\] config limits\.old is declared, but no code reads it/);
    expect(review(["--markdown"]).lines[0]!).toContain("| config-never-read | limits.old |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);

    // Reading every key at once may reach any of them: no finding.
    put("apps/shop/lib/dump.ts", `export const dump = () => getPlatform().config.all();`);
    expect(kinds().filter((k) => k.startsWith("config-never-read"))).toEqual([]);
  });

  it("reports a published event type no code names; comments, tests, the manifest and its schema don't count", () => {
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
    for (const name of ["placed", "paid", "sent", "lost"]) {
      put(`apps/shop/events/${name}.json`, JSON.stringify({ type: "object", title: `shop.order.${name}.v1` }));
    }
    put(
      "apps/shop/lib/x.ts",
      `"shop.orders.read"; "shop.orders.write";
      export const PLACED = "shop.order.placed.v1";
      publisher.publish('shop.order.paid.v1', payload);
      /** Publishes \`shop.order.sent.v1\` once shipped. */
      const help = 'publish("shop.order.sent.v1")';
      // publish("shop.order.lost.v1")`,
    );
    put("apps/shop/lib/x.test.ts", `publish("shop.order.lost.v1");`);
    put("apps/shop/platform.app.ts", `export default { events: { publishes: [{ type: "shop.order.lost.v1" }] } };`);
    expect(kinds().filter((k) => k.startsWith("event-never-published"))).toEqual([
      "event-never-published shop.order.lost.v1",
      "event-never-published shop.order.sent.v1",
    ]);
    const text = review().lines.join("\n");
    expect(text).toMatch(
      /\[event-never-published\] the manifest publishes event shop\.order\.lost\.v1, but no code names it/,
    );
    expect(review(["--markdown"]).lines[0]!).toContain("| event-never-published | shop.order.lost.v1 |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);

    // Named in code (as a template literal too): no finding.
    put("apps/shop/lib/ship.ts", "send(`shop.order.sent.v1`); send('shop.order.lost.v1');");
    expect(kinds().filter((k) => k.startsWith("event-never-published"))).toEqual([]);
  });

  it("reports a manifest route with a permission that no route file or page serves with its methods", () => {
    writeApp(
      manifest({
        routes: [
          { path: "/api/orders", methods: ["GET"], permission: "shop.orders.read" },
          { path: "/api/orders/abc", methods: ["HEAD"], permission: "shop.orders.read" },
          { path: "/admin/**", methods: ["GET"], permission: "shop.orders.write" },
          { path: "/api/old/**", permission: "shop.orders.write" },
          { path: "/api/items", methods: ["DELETE", "PUT"], permission: "shop.orders.write" },
          { path: "/api/gone/**", expose: false },
        ],
      }),
    );
    put("apps/shop/app/api/orders/route.ts", "export function GET() {}");
    put("apps/shop/app/api/orders/[id]/route.ts", "export function GET() {}");
    put("apps/shop/app/(site)/admin/page.tsx", "export default function Page() {}");
    put(
      "apps/shop/app/api/items/route.ts",
      `export function GET() { gate("shop.orders.read"); }\n// export function PUT() {}`,
    );
    expect(kinds().filter((k) => k.startsWith("route-not-served"))).toEqual([
      "route-not-served /api/old/**",
      "route-not-served DELETE,PUT /api/items",
    ]);
    const found = (JSON.parse(review(["--json"]).lines[0]!) as { reviews: AppReview[] }).reviews[0]!.findings.filter(
      (f) => f.kind === "route-not-served",
    );
    expect(found[0]!.file).toBeUndefined();
    expect(found[0]!.message).toMatch(/no route file or page serves it, so the check guards nothing/);
    expect(found[1]!.file).toBe("apps/shop/app/api/items/route.ts");
    expect(found[1]!.message).toMatch(/no file serving it answers DELETE or PUT/);
    expect(review(["--markdown"]).lines[0]!).toContain("| route-not-served | /api/old/\\*\\* |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);

    // The handlers come back: no finding.
    put("apps/shop/app/api/old/[...rest]/route.ts", "export function POST() {}");
    put(
      "apps/shop/app/api/items/route.ts",
      `export function GET() { gate("shop.orders.read"); }\nconst update = () => 1;\nexport { update as PUT };`,
    );
    expect(kinds().filter((k) => k.startsWith("route-not-served"))).toEqual([]);
  });

  it("checks only the file Next.js picks for a path: a static route file wins over a dynamic one", () => {
    writeApp(manifest({ routes: [{ path: "/api/items", methods: ["GET"], permission: "shop.orders.read" }] }));
    put("apps/shop/lib/x.ts", `"shop.orders.write"`);
    put("apps/shop/app/api/items/route.ts", `export function POST() { gate("shop.orders.read"); }`);
    put("apps/shop/app/api/[kind]/route.ts", `export function GET() { gate("shop.orders.read"); }`);
    expect(kinds().filter((k) => k.startsWith("route-not-served"))).toEqual(["route-not-served GET /api/items"]);
  });

  it("reports a schema file in events/ that no published event points to", () => {
    writeApp(
      manifest({
        events: {
          publishes: [
            { type: "shop.order.placed.v1", schema: "./events/placed.json" },
            { type: "shop.order.paid.v1", schema: "./events/../events/paid.json" },
          ],
        },
      }),
    );
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write"; "shop.order.placed.v1"; "shop.order.paid.v1";`);
    for (const name of ["placed", "paid", "placed-old", "sent"]) {
      put(`apps/shop/events/${name}.json`, JSON.stringify({ type: "object" }));
    }
    put("apps/shop/events/README.md", "not a schema"); // only .json files are schemas
    put("apps/shop/events/old/lost.json", "{}"); // only the top of events/ is checked
    put("apps/shop/app/events/stale.json", "{}"); // app/events/ holds handlers, not schemas
    expect(kinds().filter((k) => k.startsWith("event-schema"))).toEqual([
      "event-schema-unused events/placed-old.json",
      "event-schema-unused events/sent.json",
    ]);
    const found = (JSON.parse(review(["--json"]).lines[0]!) as { reviews: AppReview[] }).reviews[0]!.findings.filter(
      (f) => f.kind === "event-schema-unused",
    );
    expect(found[0]!.file).toBe("apps/shop/events/placed-old.json");
    expect(found[0]!.message).toMatch(/no published event in the manifest points to/);
    expect(review().lines.join("\n")).toMatch(/\[event-schema-unused\] events\/sent\.json is an event schema/);
    expect(review(["--markdown"]).lines[0]!).toContain("| event-schema-unused | events/sent.json |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);
  });

  it("reports no unused event schema for an app without an events/ folder", () => {
    writeApp(manifest());
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    expect(kinds()).toEqual([]);
  });

  it("reports a declared permission that no role grants", () => {
    writeApp(
      manifest({
        permissions: [
          { key: "shop.orders.read", description: "See orders" },
          { key: "shop.orders.write", description: "Change orders" },
          { key: "shop.orders.refund", description: "Refund orders" },
        ],
        roles: [
          { key: "shop.clerk", grants: ["shop.orders.read"], description: "Clerk" },
          { key: "shop.viewer", grants: ["shop.orders.read"], description: "Viewer" },
        ],
      }),
    );
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write"; "shop.orders.refund";`);
    expect(kinds()).toEqual(["permission-not-granted shop.orders.write", "permission-not-granted shop.orders.refund"]);
    const found = (JSON.parse(review(["--json"]).lines[0]!) as { reviews: AppReview[] }).reviews[0]!.findings.filter(
      (f) => f.kind === "permission-not-granted",
    );
    expect(found[0]!.file).toBeUndefined();
    expect(found[0]!.message).toMatch(/no role grants it, so nobody can hold it/);
    expect(review().lines.join("\n")).toMatch(/\[permission-not-granted\] permission shop\.orders\.refund is declared/);
    expect(review(["--markdown"]).lines[0]!).toContain("| permission-not-granted | shop.orders.refund |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);
  });

  it("counts the app's wildcard grant as granting every permission, and reports none without permissions", () => {
    writeApp(manifest({ roles: [{ key: "shop.owner", grants: ["shop.*"], description: "Owner" }] }));
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    expect(kinds()).toEqual([]);
    writeApp(manifest({ permissions: [], roles: [] }));
    expect(kinds()).toEqual([]);
  });

  it("reports a nav link no page or GET route file serves, once per href", () => {
    const nav = (...links: [string, string][]) =>
      manifest({ ui: { ...manifest().ui, nav: links.map(([label, href]) => ({ label, href })) } });
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    put("apps/shop/app/page.tsx", "export default function Page() { return null; }");
    put("apps/shop/app/(shop)/orders/page.tsx", "export default function Page() { return null; }");
    put("apps/shop/app/items/[id]/page.tsx", "export default function Page() { return null; }");
    put("apps/shop/app/export/route.ts", `import "@/lib/x";\nexport const GET = () => new Response();`);
    // served by the root page, a page in a route group (with a trailing slash), a dynamic page, and a GET route
    writeApp(nav(["Home", "/"], ["Orders", "/orders/"], ["Item", "/items/42"], ["Export", "/export"]));
    expect(kinds()).toEqual([]);

    // a moved page, twice under two labels: one finding naming both; a route file without GET
    put("apps/shop/app/upload/route.ts", `import "@/lib/x";\n// export function GET() {}\nexport function POST() {}`);
    writeApp(nav(["Old orders", "/order"], ["Orders", "/order"], ["Upload", "/upload"], ["Home", "/"]));
    const out = json();
    expect(out.reviews[0]!.findings.map((f) => `${f.kind} ${f.subject}`)).toEqual([
      "nav-target-missing /order",
      "nav-target-missing /upload",
    ]);
    const [moved, noGet] = out.reviews[0]!.findings as unknown as { message: string; file?: string }[];
    expect(moved!.file).toBeUndefined();
    expect(moved!.message).toMatch(
      /^the nav link "Old orders", "Orders" points to \/order, but no page or route file serves it/,
    );
    expect(noGet!.file).toBe("apps/shop/app/upload/route.ts");
    expect(noGet!.message).toMatch(/doesn't export GET, so the link answers 405/);
    expect(review().lines.join("\n")).toMatch(
      /\[nav-target-missing\] the nav link "Old orders", "Orders" points to \/order/,
    );
    expect(review(["--markdown"]).lines[0]!).toContain("| nav-target-missing | /upload |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);

    // the static route answers before the dynamic page
    put("apps/shop/app/items/new/route.ts", `import "@/lib/x";\nexport function POST() {}`);
    writeApp(nav(["New item", "/items/new"]));
    expect(kinds()).toEqual(["nav-target-missing /items/new"]);
  });

  it("reports a public path no route file, page or public/ file serves, once per glob", () => {
    const pub = (...paths: string[]) => manifest({ auth: { client: "oidc", publicPaths: paths } });
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    put("apps/shop/app/(site)/about/page.tsx", "export default function Page() { return null; }");
    put("apps/shop/app/docs/[...slug]/page.tsx", "export default function Page() { return null; }");
    put("apps/shop/app/hooks/[name]/route.ts", `import "@/lib/x";\nexport function POST() {}`);
    put("apps/shop/public/robots.txt", "User-agent: *");
    put("apps/shop/public/img/logo.svg", "<svg/>");
    // a page in a route group, a catch-all page under a glob, a dynamic POST-only route, static files
    writeApp(pub("/api/health", "/about", "/docs/**", "/hooks/github", "/robots.txt", "/img/*"));
    expect(kinds()).toEqual([]);

    // a moved page and a removed webhook folder, the first listed twice: one finding per glob
    writeApp(pub("/api/health", "/pricing", "/pricing", "/webhooks/**", "/favicon.ico"));
    const out = json();
    expect(out.reviews[0]!.findings.map((f) => `${f.kind} ${f.subject}`)).toEqual([
      "public-path-not-served /pricing",
      "public-path-not-served /webhooks/**",
      "public-path-not-served /favicon.ico",
    ]);
    const found = out.reviews[0]!.findings[0] as unknown as { message: string; file?: string };
    expect(found.file).toBeUndefined();
    expect(found.message).toMatch(
      /^auth\.publicPaths lists \/pricing, but no route file, page or public\/ file serves it/,
    );
    expect(review().lines.join("\n")).toMatch(/\[public-path-not-served\] auth\.publicPaths lists \/webhooks\/\*\*/);
    expect(review(["--markdown"]).lines[0]!).toContain("| public-path-not-served | /pricing |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);

    // a static file is served at its literal path: a [slug] in its name isn't a dynamic segment
    put("apps/shop/public/files/[slug]/a.txt", "a");
    writeApp(pub("/api/health", "/files/secret/a.txt", "/files/[slug]/a.txt"));
    expect(kinds()).toEqual(["public-path-not-served /files/secret/a.txt"]);
  });

  it("reports a subscription with no route serving its handler and no code naming its type", () => {
    writeApp(
      manifest({
        events: {
          subscribes: [
            { type: "billing.invoice.paid.v1", handler: "/events/invoice-paid" },
            { type: "billing.invoice.void.v1", handler: "/events/billing/void" },
            { type: "crm.lead.won.v1", handler: "/events/lead-won" },
            { type: "crm.lead.lost.v1", handler: "/events/lead-lost" },
          ],
        },
      }),
    );
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    // served by an exact route, by a dynamic one, and by code that names the type; the last has nothing
    put("apps/shop/app/events/invoice-paid/route.ts", `import "@/lib/x";\nexport function POST() {}`);
    put("apps/shop/app/events/billing/[kind]/route.ts", `import "@/lib/x";\nexport function POST() {}`);
    put("apps/shop/lib/consumer.ts", `on("crm.lead.won.v1", handle);`);
    put("apps/shop/lib/consumer.test.ts", `on("crm.lead.lost.v1", handle);`);
    expect(kinds()).toEqual(["event-handler-missing crm.lead.lost.v1"]);
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
        ...manifest({ id: "other", permissions: [], roles: [] }),
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

  it("finds nothing in a freshly scaffolded app: its permission is checked and its routes are guarded", () => {
    expect(scaffoldApp(root, { id: "fresh" }).ok).toBe(true);
    expect(kinds(["fresh"])).toEqual([]);
    const out = reviewCommand(["fresh", "--strict", "--json", "--root", root], root, () => root)!;
    const [review] = (JSON.parse(out.lines[0]!) as { reviews: { handlers: number; plumbing: number }[] }).reviews;
    expect(review!.handlers - review!.plumbing).toBe(3); // /health/live, /health/ready and the gated /api/hello
    expect(out.ok).toBe(true);
  });

  it("finds nothing in this workspace's own apps", () => {
    const out = reviewCommand(["--json"], WORKSPACE, () => WORKSPACE)!;
    const { reviews } = JSON.parse(out.lines[0]!) as { reviews: { app: string; findings: unknown[] }[] };
    expect(reviews.map((r) => r.app)).toEqual(expect.arrayContaining(["docs", "notes"]));
    expect(reviews.flatMap((r) => r.findings)).toEqual([]);
  });
});

describe("platform manifest review --markdown", () => {
  const finding = (app: string, kind: string, subject: string, message: string, file?: string) =>
    ({ app, kind, subject, message, ...(file ? { file } : {}) }) as AppReview["findings"][number];
  const reviewOf = (app: string, findings: AppReview["findings"]): AppReview => ({
    app,
    findings,
    handlers: 0,
    plumbing: 0,
  });

  it("starts with the hidden marker and says it is advisory", () => {
    writeApp(manifest());
    const out = review(["--markdown"]);
    expect(out.ok).toBe(true);
    expect(out.stdout).toBe(true);
    const lines = out.lines[0]!.split("\n");
    expect(lines[0]).toBe(MARKDOWN_MARKER);
    expect(lines).not.toContain(MARKDOWN_CLEAN_MARKER);
    expect(out.lines[0]).toMatch(/^2 findings across 1 app \(of 1 reviewed\)\.$/m);
    expect(out.lines[0]).toMatch(/Advisory/);
    expect(out.lines[0]).toContain("| permission-never-checked | shop.orders.read |  | permission shop.orders.read");
  });

  it("reports no findings plainly, with the clean marker second", () => {
    expect(scaffoldApp(root, { id: "fresh" }).ok).toBe(true);
    const md = review(["--markdown"]).lines[0]!;
    const lines = md.split("\n");
    expect(lines.slice(0, 2)).toEqual([MARKDOWN_MARKER, MARKDOWN_CLEAN_MARKER]);
    expect(md).toContain("No findings in 1 app reviewed.");
    expect(md).not.toContain("| kind |");
    expect(renderMarkdown([])).toContain("No findings in 0 apps reviewed.");
  });

  it("keeps --strict's exit code, and still prints the report", () => {
    writeApp(manifest());
    const out = review(["--markdown", "--strict"]);
    expect(out.ok).toBe(false);
    expect(out.stdout).toBe(true);
    expect(out.lines[0]!.split("\n")[0]).toBe(MARKDOWN_MARKER);
  });

  it("lists manifests it could not review, and is then not clean", () => {
    put("apps/shop/platform.app.json", JSON.stringify({ id: "shop" }));
    const out = review(["--markdown"]);
    expect(out.ok).toBe(false);
    expect(out.lines[0]).not.toContain(MARKDOWN_CLEAN_MARKER);
    expect(out.lines[0]).toMatch(/### Not reviewed\n\n- ✖ apps\/shop\/platform\.app\.json: not a valid manifest/);
  });

  it("escapes cells: a | can't split a cell, and no newline, backtick or HTML gets through", () => {
    expect(markdownCell("a|b")).toBe("a\\|b");
    expect(markdownCell("one\ntwo\r\nthree")).toBe("one two three");
    expect(markdownCell("`x` <!-- y --> & [z]")).toBe("\\`x\\` &lt;!-- y --&gt; &amp; \\[z\\]");
    expect(markdownCell("a\\|b")).toBe("a\\\\\\|b");
    const md = renderMarkdown([
      reviewOf("shop", [finding("shop", "route-unguarded", "GET /a|b", "bad | pipe\nnext line", "apps/x`y`.ts")]),
    ]);
    const row = md.split("\n").find((l) => l.startsWith("| route-unguarded"))!;
    expect(row).toBe("| route-unguarded | GET /a\\|b | apps/x\\`y\\`.ts | bad \\| pipe next line |");
    // Exactly five unescaped pipes: four cells.
    expect(row.replace(/\\\|/g, "").split("|")).toHaveLength(6);
    expect(md.split("\n").filter((l) => l.includes("<!--"))).toEqual([MARKDOWN_MARKER]);
  });

  it("renders the same report whatever order apps and findings come in", () => {
    const a = [
      finding("shop", "route-unguarded", "POST /b", "m2", "apps/shop/b.ts"),
      finding("shop", "permission-never-checked", "shop.x", "m1"),
      finding("shop", "route-unguarded", "GET /a", "m3", "apps/shop/a.ts"),
    ];
    const b = [finding("billing", "event-not-declared", "billing.x.y.v1", "m4", "apps/billing/x.ts")];
    const one = renderMarkdown([reviewOf("shop", a), reviewOf("billing", b), reviewOf("empty", [])]);
    const two = renderMarkdown([reviewOf("empty", []), reviewOf("billing", b), reviewOf("shop", [...a].reverse())]);
    expect(one).toBe(two);
    expect(one).toMatch(/^4 findings across 2 apps \(of 3 reviewed\)\.$/m);
    expect(one.indexOf("### billing")).toBeLessThan(one.indexOf("### shop"));
    expect(one).not.toContain("### empty");
    const rows = one.split("\n").filter((l) => /^\| (?!kind|---)/.test(l));
    expect(rows.map((r) => r.split(" | ")[1])).toEqual(["billing.x.y.v1", "shop.x", "GET /a", "POST /b"]);
  });

  it("rejects --json together with --markdown", () => {
    expect(reviewCommand(["--json", "--markdown"], root, () => root)).toBeNull();
    expect(reviewCommand(["--markdown", "--json", "--root", root], root, () => root)).toBeNull();
  });
});
