import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkedKeysIn,
  exportedMethods,
  globRegex,
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
  routeUrl,
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
    writeApp(manifest({ roles: [{ key: "shop.clerk", grants: ["shop.orders.read"], description: "Clerk" }] }));
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
