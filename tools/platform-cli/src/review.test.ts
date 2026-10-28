import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateManifest } from "@asafarim/app-manifest";
import { MAX_EVENT_SCHEMAS_REQUEST_BYTES, MAX_EVENT_SCHEMA_BYTES } from "@asafarim/events";
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
  FINDING_KINDS,
  readsAllConfig,
  pageUrl,
  routeUrl,
  stringLiterals,
  routeUrlRegex,
  samplePaths,
  sourceFiles,
  stripComments,
  dockerfilePort,
  stackedRoutes,
  type AppReview,
} from "./review.ts";
import { RESERVED_SERVICE_NAMES, buildCompose } from "./compose.ts";
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

/** Writes a second app `id` (no permissions, its own image) with the given `domains`, and its health route. */
function writeOtherApp(id: string, domains?: Record<string, unknown>) {
  put(
    `apps/${id}/platform.app.json`,
    JSON.stringify({
      ...manifest({ id, permissions: [], roles: [], ...(domains ? { domains } : {}) }),
      runtime: { ...manifest().runtime, image: id },
    }),
  );
  put(`apps/${id}/app/api/health/route.ts`, "export function GET() {}");
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
  it("reads the PORT a Dockerfile's final image runs with", () => {
    expect(dockerfilePort("FROM node:22\nENV PORT=3000\n")).toBe("3000");
    // both ENV forms, several keys on one line, quotes, continuation lines, case-insensitive instructions
    expect(dockerfilePort('FROM node:22\nenv NODE_ENV=production PORT="4000" HOSTNAME=0.0.0.0\n')).toBe("4000");
    expect(dockerfilePort("FROM node:22\nENV PORT 5000\n")).toBe("5000");
    expect(dockerfilePort("FROM node:22\nENV A=1 \\\n    PORT=6000\n")).toBe("6000");
    // the last assignment of the final stage wins; comments and earlier unrelated stages don't count
    expect(dockerfilePort("FROM node AS deps\nENV PORT=1\nFROM node\n# ENV PORT=2\nENV PORT=3\nENV PORT=4\n")).toBe(
      "4",
    );
    expect(dockerfilePort("FROM node AS build\nENV PORT=1\nFROM node:22-slim\nCMD x\n")).toBeUndefined();
    // a stage built FROM an earlier stage inherits its ENV, through any number of steps
    expect(
      dockerfilePort("FROM node AS base\nENV PORT=7000\nFROM base AS mid\nFROM --platform=linux/amd64 MID\n"),
    ).toBe("7000");
    // a comment line inside a continued instruction doesn't end it; an escaped space keeps text in its value
    expect(dockerfilePort("FROM node\nENV NODE_ENV=production \\\n# the port\n    PORT=8080\n")).toBe("8080");
    expect(dockerfilePort("FROM node\nENV MESSAGE=hello\\ PORT=8080\n")).toBeUndefined();
    expect(dockerfilePort("FROM node\nENV MESSAGE=\"a PORT=1\" PORT='2'\n")).toBe("2");
    // the raw value comes back: the caller decides what a literal number is
    expect(dockerfilePort("FROM node\nARG P=1\nENV PORT=${P}\n")).toBe("${P}");
    expect(dockerfilePort("ENV PORT=1\n")).toBeUndefined();
    expect(dockerfilePort("FROM node\nENV PORTS=1 MYPORT=2\n")).toBeUndefined();
  });

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
    expect(routeUrlRegex("/").test("/x")).toBe(false);
    expect(routeUrlRegex("/[[...p]]").test("/")).toBe(true);
    expect(routeUrlRegex("/[[...p]]").test("/a/b")).toBe(true);
    expect(routeUrlRegex("/[[...p]]").test("")).toBe(true);
    expect(routeUrlRegex("/[...p]").test("/")).toBe(false);
    expect(routeUrlRegex("/[id]").test("/")).toBe(false);
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

  it("reports an event schema that doesn't compile as the publisher compiles it (strict JSON Schema 2020-12)", () => {
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
    // Compiles: a plain object schema with a known format.
    put(
      "apps/shop/events/placed.json",
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["at"],
        properties: { at: { type: "string", format: "date-time" } },
      }),
    );
    // An unknown keyword (a typo of "required"): strict mode refuses it.
    put("apps/shop/events/paid.json", JSON.stringify({ type: "object", requird: ["id"] }));
    // An unknown format.
    put("apps/shop/events/sent.json", JSON.stringify({ type: "string", format: "order-id" }));
    // A $ref that resolves to nothing.
    put("apps/shop/events/lost.json", JSON.stringify({ $ref: "#/$defs/nope" }));
    put(
      "apps/shop/lib/x.ts",
      `"shop.orders.read"; "shop.orders.write";
      ["shop.order.placed.v1", "shop.order.paid.v1", "shop.order.sent.v1", "shop.order.lost.v1"];`,
    );
    expect(kinds()).toEqual([
      "event-schema-uncompilable shop.order.paid.v1",
      "event-schema-uncompilable shop.order.sent.v1",
      "event-schema-uncompilable shop.order.lost.v1",
    ]);
    const out = JSON.parse(review(["--json"]).lines[0]!) as { reviews: AppReview[] };
    const paid = out.reviews[0]!.findings.find((f) => f.subject === "shop.order.paid.v1")!;
    expect(paid.file).toBe("apps/shop/events/paid.json");
    expect(paid.message).toMatch(/doesn't compile \(.*requird.*\), so the app's publisher throws when it starts/);
  });

  it("reports an event schema larger than core-api's upload limits, per type and for the whole upload", () => {
    const at = (n: number) => `shop.order.s${n}.v1`;
    const schemaOf = (size: number) => {
      const base = { type: "object", description: "" };
      const fill = size - Buffer.byteLength(JSON.stringify(base));
      return { ...base, description: "x".repeat(fill) };
    };
    const publish = (n: number) =>
      writeApp(
        manifest({
          events: {
            publishes: Array.from({ length: n }, (_, i) => ({ type: at(i), schema: `./events/s${i}.json` })),
          },
        }),
      );
    const code = (n: number) =>
      put(
        "apps/shop/lib/x.ts",
        `"shop.orders.read"; "shop.orders.write"; ${Array.from({ length: n }, (_, i) => `"${at(i)}";`).join(" ")}`,
      );

    // Exactly at the limit, written indented: core-api measures the parsed schema re-serialised, so it fits.
    publish(2);
    code(2);
    put("apps/shop/events/s0.json", JSON.stringify(schemaOf(MAX_EVENT_SCHEMA_BYTES), null, 2));
    put("apps/shop/events/s1.json", JSON.stringify(schemaOf(MAX_EVENT_SCHEMA_BYTES + 1)));
    expect(kinds()).toEqual([`event-schema-too-large ${at(1)}`]);
    expect(json().reviews[0]!.findings[0]).toEqual({
      app: "shop",
      kind: "event-schema-too-large",
      subject: at(1),
      file: "apps/shop/events/s1.json",
      message: `the schema of ${at(1)} is ${MAX_EVENT_SCHEMA_BYTES + 1} bytes as JSON, over core-api's ${MAX_EVENT_SCHEMA_BYTES}; core-api refuses the app's whole schema upload, so the event catalog shows none of its schemas`,
    });
    expect(review(["--markdown"]).lines[0]!).toContain(`| event-schema-too-large | ${at(1)} |`);
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);

    // Each schema fits, but together they are over the request limit: one finding for the app.
    const n = Math.ceil(MAX_EVENT_SCHEMAS_REQUEST_BYTES / MAX_EVENT_SCHEMA_BYTES) + 1;
    publish(n);
    code(n);
    for (let i = 0; i < n; i++) put(`apps/shop/events/s${i}.json`, JSON.stringify(schemaOf(MAX_EVENT_SCHEMA_BYTES)));
    expect(kinds()).toEqual(["event-schema-too-large events.publishes"]);
    const all = (JSON.parse(review(["--json"]).lines[0]!) as { reviews: AppReview[] }).reviews[0]!.findings[0]!;
    expect(all.file).toBeUndefined();
    expect(all.message).toMatch(
      new RegExp(
        `^the app's event schemas upload as one \\d+-byte request, over core-api's ${MAX_EVENT_SCHEMAS_REQUEST_BYTES}; core-api refuses it`,
      ),
    );

    // Small schemas: nothing to report.
    for (let i = 0; i < n; i++) put(`apps/shop/events/s${i}.json`, JSON.stringify(schemaOf(1024)));
    expect(kinds()).toEqual([]);
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

  it("reads a GET-limited route as covering HEAD, as the gateway does, but not the other way round", () => {
    writeApp(
      manifest({
        routes: [
          { path: "/api/orders", methods: ["GET"], permission: "shop.orders.read" },
          { path: "/api/stock", methods: ["HEAD"], permission: "shop.orders.read" },
        ],
      }),
    );
    put("apps/shop/lib/x.ts", `"shop.orders.write"`);
    put("apps/shop/app/api/orders/route.ts", "export function GET() {}\nexport function HEAD() {}");
    put("apps/shop/app/api/stock/route.ts", "export function GET() {}\nexport function HEAD() {}");
    expect(kinds()).toEqual(["route-unguarded GET /api/stock"]);
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

  it("reports a public launcher tile whose start page needs sign-in", () => {
    const tile = (access: string) => ({ description: "Shop", meta: "shop.asafarim.site", access, order: 10 });
    const app = (access: string | undefined, publicPaths: string[], over: Record<string, unknown> = {}) =>
      manifest({
        auth: { client: "oidc", publicPaths },
        ui: {
          glyph: "SH",
          color: "#2563eb",
          nav: [],
          status: "active",
          ...(access ? { launcher: tile(access) } : {}),
          ...over,
        },
      });
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    put("apps/shop/app/page.tsx", "export default function Page() { return null; }");

    // no tile, an authenticated tile, "/" public exactly or through "/**"
    writeApp(app(undefined, ["/api/health"]));
    expect(kinds()).toEqual([]);
    writeApp(app("authenticated", ["/api/health"]));
    expect(kinds()).toEqual([]);
    writeApp(app("public", ["/api/health", "/"]));
    expect(kinds()).toEqual([]);
    writeApp(app("public", ["/**"]));
    expect(kinds()).toEqual([]);
    // a tile that can't be opened yet, and an app that never signs anyone in
    writeApp(app("public", ["/api/health"], { status: "coming-soon" }));
    expect(kinds()).toEqual([]);
    writeApp(manifest({ auth: { client: "none", publicPaths: ["/api/health"] }, ui: app("public", []).ui }));
    expect(kinds()).toEqual([]);

    // "/about" doesn't cover "/"
    writeApp(app("public", ["/api/health", "/about"]));
    put("apps/shop/app/about/page.tsx", "export default function Page() { return null; }");
    const out = json();
    expect(out.reviews[0]!.findings.map((f) => `${f.kind} ${f.subject}`)).toEqual([
      "launcher-not-public ui.launcher.access",
    ]);
    const found = out.reviews[0]!.findings[0] as unknown as { message: string; file?: string };
    expect(found.file).toBeUndefined();
    expect(found.message).toMatch(
      /^the launcher tile says anyone may open shop \(access "public"\), but no auth\.publicPaths entry covers \//,
    );
    expect(review().lines.join("\n")).toMatch(/\[launcher-not-public\] the launcher tile says anyone may open shop/);
    expect(review(["--markdown"]).lines[0]!).toContain("| launcher-not-public | ui.launcher.access |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);
  });

  it("reports a public path the gateway still guards with a permission, once per glob", () => {
    const app = (publicPaths: string[], routes: unknown[]) =>
      manifest({ auth: { client: "oidc", publicPaths }, routes });
    const guard = (p: string, permission: string, over: Record<string, unknown> = {}) => ({
      path: p,
      permission,
      ...over,
    });
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    put("apps/shop/app/orders/page.tsx", "export default function Page() { return null; }");
    put("apps/shop/app/orders/[id]/page.tsx", "export default function Page() { return null; }");
    put("apps/shop/app/about/page.tsx", "export default function Page() { return null; }");
    put("apps/shop/app/api/orders/route.ts", `import "@/lib/x";\nexport function GET() {}\nexport function POST() {}`);

    // "/**" public with guarded API routes (a partial overlap), a guard limited by methods, no overlap,
    // and a guard that covers "/orders" but not "/orders/x"
    writeApp(app(["/api/health", "/**"], [guard("/api/orders", "shop.orders.read")]));
    expect(kinds()).toEqual([]);
    writeApp(app(["/api/health", "/api/orders"], [guard("/api/orders", "shop.orders.write", { methods: ["POST"] })]));
    expect(kinds()).toEqual([]);
    writeApp(app(["/api/health", "/about"], [guard("/orders/**", "shop.orders.read")]));
    expect(kinds()).toEqual([]);
    writeApp(app(["/api/health", "/orders/**"], [guard("/orders", "shop.orders.read")]));
    expect(kinds()).toEqual([]);
    // a hidden route (expose: false) answers 404, not sign-in (the guarded route is dead instead)
    writeApp(
      app(["/api/health", "/orders"], [guard("/orders", "shop.orders.read"), { path: "/orders", expose: false }]),
    );
    expect(kinds()).toEqual(["route-hidden /orders", "public-path-hidden /orders"]);
    // a wildcard only partly guarded: one concrete child, or fixed depths under "/**"
    writeApp(app(["/api/health", "/orders/*"], [guard("/orders/1", "shop.orders.read")]));
    expect(kinds()).toEqual([]);
    writeApp(
      app(
        ["/api/health", "/orders/**"],
        [guard("/orders", "shop.orders.read"), guard("/orders/*", "shop.orders.read")],
      ),
    );
    expect(kinds()).toEqual([]);
    // a route hidden only for POST still leaves GET behind the permission
    writeApp(
      app(
        ["/api/health", "/orders"],
        [guard("/orders", "shop.orders.read"), { path: "/orders", expose: false, methods: ["POST"] }],
      ),
    );
    expect(kinds()).toEqual(["public-path-guarded /orders"]);

    // fully covered: exactly, through "/**", and by two routes; the first glob listed twice
    writeApp(
      app(
        ["/api/health", "/api/orders", "/api/orders", "/orders/*", "/orders/**"],
        [
          guard("/api/orders", "shop.orders.read"),
          guard("/orders", "shop.orders.write"),
          guard("/orders/**", "shop.orders.read"),
        ],
      ),
    );
    const out = json();
    expect(out.reviews[0]!.findings.map((f) => `${f.kind} ${f.subject}`)).toEqual([
      "public-path-guarded /api/orders",
      "public-path-guarded /orders/*",
      "public-path-guarded /orders/**",
    ]);
    const [one, , two] = out.reviews[0]!.findings as unknown as { message: string; file?: string }[];
    expect(one!.file).toBeUndefined();
    expect(one!.message).toMatch(
      /^auth\.publicPaths lists \/api\/orders, but manifest routes put the permission shop\.orders\.read on every path it covers/,
    );
    expect(two!.message).toMatch(/put a permission \(shop\.orders\.read, shop\.orders\.write\) on every path/);
    expect(review().lines.join("\n")).toMatch(/\[public-path-guarded\] auth\.publicPaths lists \/orders\/\*\*/);
    expect(review(["--markdown"]).lines[0]!).toContain("| public-path-guarded | /api/orders |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);
  });

  it("reports a guarded route that a hidden route covers for every path and method", () => {
    const app = (routes: unknown[]) => manifest({ routes });
    const guard = (p: string, over: Record<string, unknown> = {}) => ({
      path: p,
      permission: "shop.orders.read",
      ...over,
    });
    const hide = (p: string, over: Record<string, unknown> = {}) => ({ path: p, expose: false, ...over });
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    put(
      "apps/shop/app/internal/sync/route.ts",
      `import "@/lib/x";\nexport function GET() {}\nexport function POST() {}`,
    );
    put("apps/shop/app/internal/jobs/[id]/route.ts", `import "@/lib/x";\nexport function GET() {}`);
    put("apps/shop/app/orders/page.tsx", "export default function Page() { return null; }");
    put("apps/shop/app/admin/page.tsx", "export default function Page() { return null; }");
    put("apps/shop/app/reports/page.tsx", "export default function Page() { return null; }");
    put("apps/shop/app/exports/page.tsx", "export default function Page() { return null; }");
    put("apps/shop/app/status/page.tsx", "export default function Page() { return null; }");

    // partial overlaps: a hidden child, fixed depths under "/**", a hidden glob limited to other
    // methods, a guarded route with no methods limit hidden only for some, and no overlap at all
    writeApp(app([guard("/internal/**"), hide("/internal/sync")]));
    expect(kinds()).toEqual([]);
    writeApp(app([guard("/internal/**"), hide("/internal/*")]));
    expect(kinds()).toEqual([]);
    writeApp(app([guard("/internal/sync", { methods: ["GET", "POST"] }), hide("/internal/**", { methods: ["POST"] })]));
    expect(kinds()).toEqual([]);
    writeApp(app([guard("/internal/sync"), hide("/internal/**", { methods: ["GET", "POST"] })]));
    expect(kinds()).toEqual([]);
    writeApp(app([guard("/orders"), hide("/internal/**")]));
    expect(kinds()).toEqual([]);
    writeApp(app([guard("/orders"), hide("/orders", { methods: ["GET"] }), hide("/orders", { methods: ["POST"] })]));
    expect(kinds()).toEqual([]);
    writeApp(app([guard("/orders", { methods: ["GET"] }), hide("/orders", { methods: ["HEAD"] })]));
    expect(kinds()).toEqual([]);

    // fully hidden: under a "/**" prefix, by methods that include the route's, exactly, and by two globs
    writeApp(
      app([
        guard("/internal/sync", { methods: ["POST"] }),
        guard("/internal/jobs/*"),
        guard("/orders", { permission: "shop.orders.write" }),
        guard("/admin/**"),
        guard("/reports", { methods: ["GET", "POST"] }),
        guard("/exports"),
        hide("/internal/**", { methods: ["GET", "POST"] }),
        hide("/internal/jobs/**"),
        hide("/orders"),
        hide("/admin"),
        hide("/admin/**"),
        hide("/reports", { methods: ["GET"] }),
        hide("/reports", { methods: ["POST", "DELETE"] }),
        hide("/exports", { methods: ["GET", "HEAD", "POST", "PUT"] }),
        hide("/exports", { methods: ["PATCH", "DELETE", "OPTIONS"] }),
        guard("/status", { methods: ["GET", "HEAD"] }),
        hide("/status", { methods: ["GET"] }),
      ]),
    );
    const out = json();
    expect(out.reviews[0]!.findings.map((f) => `${f.kind} ${f.subject}`)).toEqual([
      "route-hidden POST /internal/sync",
      "route-hidden /internal/jobs/*",
      "route-hidden /orders",
      "route-hidden /admin/**",
      "route-hidden GET,POST /reports",
      "route-hidden /exports",
      "route-hidden GET,HEAD /status",
    ]);
    const [one, two, three] = out.reviews[0]!.findings as unknown as { message: string; file?: string }[];
    expect(one!.file).toBeUndefined();
    expect(one!.message).toMatch(
      /^the manifest guards POST \/internal\/sync with shop\.orders\.read, but \/internal\/\*\* hides it \(expose: false\), and the gateway answers 404 there/,
    );
    expect(two!.message).toMatch(/but \/internal\/\*\* and \/internal\/jobs\/\*\* hide it/);
    expect(three!.message).toMatch(/^the manifest guards \/orders with shop\.orders\.write, but \/orders hides it/);
    expect((out.reviews[0]!.findings[3] as unknown as { message: string }).message).toMatch(
      /but \/admin and \/admin\/\*\* hide it/,
    );
    expect(review().lines.join("\n")).toMatch(/\[route-hidden\] the manifest guards \/admin\/\*\* with/);
    expect(review(["--markdown"]).lines[0]!).toContain("| route-hidden | POST /internal/sync |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);
  });

  it("reports a public path a hidden route covers for every path and method, once per glob", () => {
    const app = (publicPaths: string[], routes: unknown[]) =>
      manifest({ auth: { client: "oidc", publicPaths: ["/api/health", ...publicPaths] }, routes });
    const hide = (p: string, over: Record<string, unknown> = {}) => ({ path: p, expose: false, ...over });
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    for (const page of ["internal/about", "internal/x/[y]", "status", "reports", "exports", "orders"]) {
      put(`apps/shop/app/${page}/page.tsx`, "export default function Page() { return null; }");
    }

    // no hidden route, a partial overlap (a hidden child, fixed depths under "/**"), hiding limited to
    // some methods only, and no overlap at all
    writeApp(app(["/internal/about"], []));
    expect(kinds()).toEqual([]);
    writeApp(app(["/internal/**"], [hide("/internal/about")]));
    expect(kinds()).toEqual([]);
    writeApp(app(["/internal/**"], [hide("/internal"), hide("/internal/*")]));
    expect(kinds()).toEqual([]);
    writeApp(app(["/status"], [hide("/status", { methods: ["GET"] })]));
    expect(kinds()).toEqual([]);
    // every method but GET (HEAD doesn't cover GET)
    writeApp(app(["/status"], [hide("/status", { methods: ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] })]));
    expect(kinds()).toEqual([]);
    writeApp(app(["/orders"], [hide("/internal/**")]));
    expect(kinds()).toEqual([]);
    // a hidden literal can't stand in for every segment a "*" covers, whatever its name
    writeApp(app(["/internal/x/*"], [hide("/internal/x/~any~")]));
    expect(kinds()).toEqual([]);
    // a glob that covers a health path: the poller calls the app directly, so hiding it is fine
    writeApp(manifest({ auth: { client: "oidc", publicPaths: ["/api/**"] }, routes: [hide("/api/**")] }));
    expect(kinds()).toEqual([]);

    // fully hidden: under a "/**" prefix, exactly, by methods that add up (GET also covers HEAD), and
    // by two globs; the first glob listed twice
    writeApp(
      app(
        ["/internal/about", "/internal/about", "/internal/x/*", "/status", "/reports", "/exports/**"],
        [
          hide("/internal/**"),
          hide("/status"),
          hide("/reports", { methods: ["GET", "POST", "PUT"] }),
          hide("/reports", { methods: ["PATCH", "DELETE", "OPTIONS"] }),
          hide("/exports"),
          hide("/exports/**"),
        ],
      ),
    );
    const out = json();
    expect(out.reviews[0]!.findings.map((f) => `${f.kind} ${f.subject}`)).toEqual([
      "public-path-hidden /internal/about",
      "public-path-hidden /internal/x/*",
      "public-path-hidden /status",
      "public-path-hidden /reports",
      "public-path-hidden /exports/**",
    ]);
    const found = out.reviews[0]!.findings as unknown as { message: string; file?: string }[];
    expect(found[0]!.file).toBeUndefined();
    expect(found[0]!.message).toMatch(
      /^auth\.publicPaths lists \/internal\/about, but \/internal\/\*\* hides every path it covers \(expose: false\), so the gateway answers 404 there for everyone/,
    );
    expect(found[3]!.message).toMatch(/but \/reports hides every path/);
    expect(found[4]!.message).toMatch(/but \/exports and \/exports\/\*\* hide every path/);
    expect(review().lines.join("\n")).toMatch(/\[public-path-hidden\] auth\.publicPaths lists \/status/);
    expect(review(["--markdown"]).lines[0]!).toContain("| public-path-hidden | /internal/about |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);
  });

  it("reports a nav link a hidden route covers for GET, once per href", () => {
    const app = (nav: [string, string][], routes: unknown[]) =>
      manifest({ routes, ui: { ...manifest().ui, nav: nav.map(([label, href]) => ({ label, href })) } });
    const hide = (p: string, over: Record<string, unknown> = {}) => ({ path: p, expose: false, ...over });
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    put("apps/shop/app/page.tsx", "export default function Page() { return null; }");
    put("apps/shop/app/orders/page.tsx", "export default function Page() { return null; }");
    put("apps/shop/app/internal/jobs/page.tsx", "export default function Page() { return null; }");
    put("apps/shop/app/internal/stats/page.tsx", "export default function Page() { return null; }");
    put("apps/shop/app/admin/page.tsx", "export default function Page() { return null; }");

    // not hidden: no hidden route, a hidden route elsewhere, hidden only for other methods, a guarded
    // (not hidden) route, and a hidden child of the link
    writeApp(
      app(
        [
          ["Home", "/"],
          ["Orders", "/orders"],
        ],
        [],
      ),
    );
    expect(kinds()).toEqual([]);
    writeApp(
      app(
        [
          ["Home", "/"],
          ["Orders", "/orders"],
          ["Admin", "/admin"],
        ],
        [
          hide("/internal/**"),
          hide("/orders", { methods: ["POST", "DELETE"] }),
          { path: "/admin", permission: "shop.orders.write" },
          hide("/admin/secret"),
        ],
      ),
    );
    expect(kinds()).toEqual([]);

    // hidden: under "/**" (twice under two labels, one with a trailing slash), exactly with GET among
    // its methods, and by two globs
    writeApp(
      app(
        [
          ["Jobs", "/internal/jobs"],
          ["Old jobs", "/internal/jobs"],
          ["Stats", "/internal/stats/"],
          ["Admin", "/admin"],
          ["Home", "/"],
        ],
        [
          hide("/internal/**"),
          hide("/internal/stats"),
          hide("/admin", { methods: ["GET", "POST"] }),
          { path: "/admin", permission: "shop.orders.write" },
        ],
      ),
    );
    const out = json();
    expect(out.reviews[0]!.findings.map((f) => `${f.kind} ${f.subject}`)).toEqual([
      "nav-target-hidden /internal/jobs",
      "nav-target-hidden /internal/stats/",
      "nav-target-hidden /admin",
    ]);
    const [jobs, stats, admin] = out.reviews[0]!.findings as unknown as { message: string; file?: string }[];
    expect(jobs!.file).toBeUndefined();
    expect(jobs!.message).toMatch(
      /^the nav link "Jobs", "Old jobs" points to \/internal\/jobs, but \/internal\/\*\* hides it \(expose: false\), so the gateway answers 404 there/,
    );
    expect(stats!.message).toMatch(/but \/internal\/\*\* and \/internal\/stats hide it/);
    expect(admin!.message).toMatch(/^the nav link "Admin" points to \/admin, but \/admin hides it/);
    expect(review().lines.join("\n")).toMatch(/\[nav-target-hidden\] the nav link "Stats" points to/);
    expect(review(["--markdown"]).lines[0]!).toContain("| nav-target-hidden | /internal/jobs |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);
  });

  it("reports a launcher tile whose start page the gateway hides", () => {
    const tile = { description: "Shop", meta: "shop.asafarim.site", access: "authenticated", order: 10 };
    const app = (routes: unknown[], ui: Record<string, unknown> = { launcher: tile }) =>
      manifest({ routes, ui: { ...manifest().ui, ...ui } });
    const hide = (p: string, over: Record<string, unknown> = {}) => ({ path: p, expose: false, ...over });
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    put("apps/shop/app/page.tsx", "export default function Page() { return null; }");

    // not hidden: no hidden route, a hidden prefix that doesn't cover "/", "/*" (one segment, not "/"),
    // hidden only for other methods, and a guarded (not hidden) "/" (launcher-target-guarded reports it)
    writeApp(app([]));
    expect(kinds()).toEqual([]);
    writeApp(
      app([
        hide("/internal/**"),
        hide("/*", { methods: ["DELETE"] }),
        hide("/", { methods: ["POST", "PUT"] }),
        { path: "/", methods: ["GET"], permission: "shop.orders.read" },
      ]),
    );
    expect(kinds()).toEqual(["launcher-target-guarded ui.launcher"]);
    // hidden, but no tile, or a tile that can't be opened yet
    writeApp(app([hide("/")], {}));
    expect(kinds()).toEqual([]);
    writeApp(app([hide("/")], { launcher: tile, status: "coming-soon" }));
    expect(kinds()).toEqual([]);

    // hidden exactly, for HEAD's GET, and through "/**"; one finding naming both globs
    writeApp(app([hide("/", { methods: ["GET"] }), hide("/**"), hide("/")]));
    let out = json();
    expect(out.reviews[0]!.findings.map((f) => `${f.kind} ${f.subject}`)).toContain(
      "launcher-target-hidden ui.launcher",
    );
    const found = out.reviews[0]!.findings.find((f) => f.kind === "launcher-target-hidden") as unknown as {
      message: string;
      file?: string;
    };
    expect(found.file).toBeUndefined();
    expect(found.message).toBe(
      "the launcher tile opens shop at /, but / and /** hide it (expose: false), so the gateway answers 404 to everyone who opens the tile (narrow the hidden path, or drop the tile)",
    );

    // a single hiding route, limited to methods that include GET
    writeApp(app([hide("/", { methods: ["GET", "POST"] })]));
    out = json();
    expect(out.reviews[0]!.findings.map((f) => `${f.kind} ${f.subject}`)).toEqual([
      "launcher-target-hidden ui.launcher",
    ]);
    expect(out.reviews[0]!.findings[0] as unknown as { message: string }).toMatchObject({
      message: expect.stringMatching(/^the launcher tile opens shop at \/, but \/ hides it \(expose: false\)/),
    });
    expect(review().lines.join("\n")).toMatch(/\[launcher-target-hidden\] the launcher tile opens shop at \//);
    expect(review(["--markdown"]).lines[0]!).toContain("| launcher-target-hidden | ui.launcher |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);
  });

  it("reports a launcher tile whose start page the gateway guards with a permission", () => {
    const tile = { description: "Shop", meta: "shop.asafarim.site", access: "authenticated", order: 10 };
    const app = (routes: unknown[], ui: Record<string, unknown> = { launcher: tile }) =>
      manifest({ routes, ui: { ...manifest().ui, ...ui } });
    const guard = (p: string, permission: string, over: Record<string, unknown> = {}) => ({
      path: p,
      permission,
      ...over,
    });
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    put("apps/shop/app/page.tsx", "export default function Page() { return null; }");
    put("apps/shop/app/api/orders/route.ts", `import "@/lib/x";\nexport function GET() {}\nexport function POST() {}`);

    // not guarded: no routes, a guarded prefix that doesn't cover "/", a guard on "/" only for a
    // method other than GET or HEAD, and an unguarded route at "/"
    writeApp(app([]));
    expect(kinds()).toEqual([]);
    writeApp(
      app([
        guard("/api/orders/**", "shop.orders.read"),
        guard("/**", "shop.orders.write", { methods: ["POST"] }),
        { path: "/", methods: ["GET"] },
      ]),
    );
    expect(kinds()).toEqual([]);
    // guarded, but no tile, a tile that can't be opened yet, or "/" hidden (launcher-target-hidden reports it)
    writeApp(app([guard("/", "shop.orders.read")], {}));
    expect(kinds()).toEqual([]);
    writeApp(app([guard("/", "shop.orders.read")], { launcher: tile, status: "coming-soon" }));
    expect(kinds()).toEqual([]);
    writeApp(app([guard("/", "shop.orders.read"), { path: "/", expose: false }]));
    expect(kinds()).toEqual(["route-hidden /", "launcher-target-hidden ui.launcher"]);

    // an authenticated tile: guarded exactly, for HEAD's GET, and through "/*" (the gateway's `*` also
    // matches an empty segment); one finding naming both permissions
    writeApp(
      app([
        guard("/", "shop.orders.read", { methods: ["GET"] }),
        guard("/*", "shop.orders.write"),
        guard("/", "shop.orders.read"),
      ]),
    );
    let out = json();
    expect(out.reviews[0]!.findings.map((f) => `${f.kind} ${f.subject}`)).toEqual([
      "launcher-target-guarded ui.launcher",
    ]);
    const authed = out.reviews[0]!.findings[0] as unknown as { message: string; file?: string };
    expect(authed.file).toBeUndefined();
    expect(authed.message).toBe(
      'the launcher tile says any signed-in user may open shop (access "authenticated"), but manifest routes put permissions (shop.orders.read, shop.orders.write) on / for GET, and the gateway asks for them, so a signed-in user without them gets 403 (take the permission off /, for example by narrowing the route, or drop the tile)',
    );

    // a public tile on an app whose "/" is public to the app: the gateway still asks for the permission
    // (here through "/**", which public-path-guarded also reports for the public globs it covers)
    writeApp({
      ...app([guard("/**", "shop.orders.read")], { launcher: { ...tile, access: "public" } }),
      auth: { client: "oidc", publicPaths: ["/", "/api/health"] },
    });
    out = json();
    expect(out.reviews[0]!.findings.map((f) => `${f.kind} ${f.subject}`)).toEqual([
      "public-path-guarded /",
      "public-path-guarded /api/health",
      "launcher-target-guarded ui.launcher",
    ]);
    expect(out.reviews[0]!.findings.find((f) => f.kind === "launcher-target-guarded")).toMatchObject({
      message:
        'the launcher tile says anyone may open shop (access "public"), but manifest routes put the permission shop.orders.read on / for GET, and the gateway asks for it, so a signed-out visitor is sent to sign-in and a signed-in user without it gets 403 (take the permission off /, for example by narrowing the route, or drop the tile)',
    });
    expect(review().lines.join("\n")).toMatch(
      /\[launcher-target-guarded\] the launcher tile says anyone may open shop/,
    );
    expect(review(["--markdown"]).lines[0]!).toContain("| launcher-target-guarded | ui.launcher |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);
  });

  it("reports a launcher tile whose start page nothing serves", () => {
    const tile = { description: "Shop", meta: "shop.asafarim.site", access: "authenticated", order: 10 };
    const app = (ui: Record<string, unknown> = { launcher: tile }) => manifest({ ui: { ...manifest().ui, ...ui } });
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);

    // nothing serves "/": no tile, a coming-soon tile, or a nav link to "/" (nav-target-missing reports it)
    writeApp(app({}));
    expect(kinds()).toEqual([]);
    writeApp(app({ launcher: tile, status: "coming-soon" }));
    expect(kinds()).toEqual([]);
    writeApp(app({ launcher: tile, nav: [{ label: "Home", href: "/" }] }));
    expect(kinds()).toEqual(["nav-target-missing /"]);

    // an active tile and nothing at "/": a page elsewhere and "/*" (one segment) don't serve it
    put("apps/shop/app/orders/page.tsx", "export default function Page() { return null; }");
    put("apps/shop/app/[slug]/page.tsx", "export default function Page() { return null; }");
    writeApp(app());
    let out = json();
    expect(out.reviews[0]!.findings.map((f) => `${f.kind} ${f.subject}`)).toEqual([
      "launcher-target-missing ui.launcher",
    ]);
    const missing = out.reviews[0]!.findings[0] as unknown as { message: string; file?: string };
    expect(missing.file).toBeUndefined();
    expect(missing.message).toBe(
      "the launcher tile opens shop at /, but no page or route file serves /, so the tile answers 404 to everyone who opens it (add app/page.tsx, or drop the tile)",
    );
    expect(review().lines.join("\n")).toMatch(/\[launcher-target-missing\] the launcher tile opens shop at \//);
    expect(review(["--markdown"]).lines[0]!).toContain("| launcher-target-missing | ui.launcher |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);

    // a route file at "/" that doesn't answer GET: 405, naming the file
    put("apps/shop/app/route.ts", `import "@/lib/x";\nexport function POST() {}`);
    out = json();
    expect(out.reviews[0]!.findings.map((f) => `${f.kind} ${f.subject}`)).toContain(
      "launcher-target-missing ui.launcher",
    );
    const noGet = out.reviews[0]!.findings.find((f) => f.kind === "launcher-target-missing") as unknown as {
      message: string;
      file?: string;
    };
    expect(noGet.file).toBe("apps/shop/app/route.ts");
    expect(noGet.message).toMatch(
      /^the launcher tile opens shop at \/, but the route file serving \/ doesn't export GET/,
    );

    // served: a route file exporting GET, a page in a route group, or an optional catch-all page
    put("apps/shop/app/route.ts", `import "@/lib/x";\nexport function GET() {}`);
    expect(kinds()).not.toContain("launcher-target-missing ui.launcher");
    rmSync(path.join(root, "apps/shop/app/route.ts"));
    put("apps/shop/app/(site)/page.tsx", "export default function Page() { return null; }");
    expect(kinds()).toEqual([]);
    rmSync(path.join(root, "apps/shop/app/(site)"), { recursive: true });
    put("apps/shop/app/[[...path]]/page.tsx", "export default function Page() { return null; }");
    expect(kinds()).toEqual([]);
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

  it("reports a subscription to a type its publisher in this repo doesn't publish", () => {
    writeApp(
      manifest({
        events: {
          publishes: [{ type: "shop.order.placed.v1", schema: "./events/placed.json" }],
          subscribes: [
            { type: "billing.invoice.paid.v1", handler: "/events/a" },
            { type: "billing.invoice.void.v1", handler: "/events/a" },
            { type: "billing.invoice.void.v1", handler: "/events/b" },
            { type: "billing.refund.issued.v1", handler: "/events/a" },
            { type: "crm.lead.won.v1", handler: "/events/a" },
            { type: "core.app.activated.v1", handler: "/events/a" },
            { type: "shop.order.placed.v1", handler: "/events/a" },
            { type: "shop.order.shipped.v1", handler: "/events/a" },
          ],
        },
      }),
    );
    put("apps/shop/events/placed.json", JSON.stringify({ type: "object" }));
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write"; "shop.order.placed.v1";`);
    put("apps/shop/app/events/a/route.ts", `import "@/lib/x";\nexport function POST() {}`);
    put("apps/shop/app/events/b/route.ts", `import "@/lib/x";\nexport function POST() {}`);
    // billing publishes paid.v1 and void.v2; crm is not in this repo
    put(
      "apps/billing/platform.app.json",
      JSON.stringify({
        ...manifest({
          id: "billing",
          permissions: [],
          roles: [],
          events: {
            publishes: [
              { type: "billing.invoice.paid.v1", schema: "./events/paid.json" },
              { type: "billing.invoice.void.v2", schema: "./events/void.json" },
            ],
          },
        }),
        runtime: { ...manifest().runtime, image: "billing" },
      }),
    );
    // only shop is reviewed, but billing's manifest is read for what it publishes; void.v1 is reported
    // once although it's listed twice (core-api refuses that repeat, reported as subscription-declared-twice)
    expect(kinds(["shop"])).toEqual([
      "subscription-not-published billing.invoice.void.v1",
      "subscription-not-published billing.refund.issued.v1",
      "subscription-not-published shop.order.shipped.v1",
      "subscription-declared-twice subscription: billing.invoice.void.v1",
    ]);
    const found = (JSON.parse(review(["shop", "--json"]).lines[0]!) as { reviews: AppReview[] }).reviews[0]!.findings;
    expect(found[0]!.file).toBeUndefined();
    expect(found[0]!.message).toMatch(
      /subscribes to billing\.invoice\.void\.v1, but billing's manifest doesn't publish it \(it publishes billing\.invoice\.void\.v2\)/,
    );
    expect(found[1]!.message).not.toMatch(/it publishes/);
    expect(review(["shop"]).lines.join("\n")).toMatch(/\[subscription-not-published\] subscribes to billing\.refund/);
    expect(review(["shop", "--markdown"]).lines[0]!).toContain(
      "| subscription-not-published | billing.invoice.void.v1 |",
    );
    expect(review(["shop"]).ok).toBe(true);
    expect(review(["shop", "--strict"]).ok).toBe(false);
  });

  it("skips publishers whose manifest is broken or invalid", () => {
    writeApp(manifest({ events: { subscribes: [{ type: "billing.invoice.paid.v1", handler: "/events/a" }] } }));
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    put("apps/shop/app/events/a/route.ts", `import "@/lib/x";\nexport function POST() {}`);
    put("apps/billing/platform.app.json", JSON.stringify({ id: "billing" }));
    expect(kinds(["shop"])).toEqual([]);
    put("apps/billing/platform.app.json", "{ not json");
    expect(kinds(["shop"])).toEqual([]);
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
    const { reviews } = JSON.parse(out.lines[0]!) as {
      reviews: { app: string; findings: { app: string; kind: string; subject: string }[] }[];
    };
    expect(reviews.map((r) => r.app)).toEqual(expect.arrayContaining(["docs", "flow", "notes"]));
    // Docs publishes every outcome Flow subscribes to (Flow PR 5): no findings at all.
    expect(reviews.flatMap((r) => r.findings)).toEqual([]);
  });
  it("reports code that reads DATABASE_URL when the manifest declares no database", () => {
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    // no code names it, or only a comment, a test or a longer name does
    writeApp(manifest());
    put("apps/shop/lib/a.ts", `// DATABASE_URL comes later\nexport const u = process.env.SHOP_DATABASE_URL;`);
    put("apps/shop/lib/db.test.ts", `process.env.DATABASE_URL = "postgres://x";`);
    expect(kinds()).toEqual([]);

    // the code reads it with engine "none": one finding, at the first file that names it
    put("apps/shop/lib/db.ts", `export const url = process.env.DATABASE_URL;`);
    put("apps/shop/lib/pool.ts", `const u = process.env["DATABASE_URL"];`);
    expect(kinds()).toEqual(["database-not-declared DATABASE_URL"]);
    const out = json();
    expect(out.reviews[0]!.findings[0]).toMatchObject({
      file: "apps/shop/lib/db.ts",
      message:
        'the code reads DATABASE_URL, but the manifest says database.engine: "none", so the platform provisions no database and the read gets undefined at runtime (declare database.engine: "postgres" with its migrations, or list DATABASE_URL in secrets for a database the app brings itself)',
    });
    expect(review().lines.join("\n")).toMatch(/\[database-not-declared\] the code reads DATABASE_URL/);
    expect(review(["--markdown"]).lines[0]!).toContain("| database-not-declared | DATABASE\\_URL |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);

    // a postgres database, or DATABASE_URL as the app's own secret, provides it
    writeApp(manifest({ database: { engine: "postgres", migrations: "sql" } }));
    expect(kinds()).toEqual([]);
    writeApp(manifest({ secrets: ["DATABASE_URL"] }));
    expect(kinds()).toEqual([]);
  });

  it("reports a postgres database that no code or Prisma schema reads", () => {
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    writeApp(manifest({ database: { engine: "postgres", migrations: "prisma" } }));
    // a comment, a test, a longer name or a schema outside the app's source doesn't read it
    put("apps/shop/lib/a.ts", `// DATABASE_URL comes later\nexport const u = process.env.SHOP_DATABASE_URL;`);
    put("apps/shop/lib/db.test.ts", `process.env.DATABASE_URL = "postgres://x";`);
    put("apps/shop/test/schema.prisma", `datasource db { url = env("DATABASE_URL") }`);
    put("apps/shop/prisma/schema.prisma", `// url = env("DATABASE_URL")\ndatasource db { url = env("SHOP_DB") }`);
    expect(kinds()).toEqual(["database-never-read DATABASE_URL"]);
    const out = json();
    expect(out.reviews[0]!.findings[0]).toEqual({
      app: "shop",
      kind: "database-never-read",
      subject: "DATABASE_URL",
      message:
        'the manifest says database.engine: "postgres", so the platform provisions a database and hands its URL as DATABASE_URL, but no code or Prisma schema reads DATABASE_URL (read process.env.DATABASE_URL where the code connects, or declare database.engine: "none" if the app no longer needs the database)',
    });
    expect(review().lines.join("\n")).toMatch(/\[database-never-read\] the manifest says database\.engine: "postgres"/);
    expect(review(["--markdown"]).lines[0]!).toContain("| database-never-read | DATABASE\\_URL |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);

    // a Prisma schema that reads it (also in the multi-file layout) is enough
    put("apps/shop/prisma/schema/base.prisma", `datasource db {\n  url = env("DATABASE_URL")\n}`);
    expect(kinds()).toEqual([]);
    rmSync(path.join(root, "apps/shop/prisma"), { recursive: true });
    expect(kinds()).toEqual(["database-never-read DATABASE_URL", "database-migrations-missing migrations: prisma"]);

    // so is runtime code that reads it, and engine "none" has nothing to read
    put("apps/shop/lib/db.ts", `export const url = process.env["DATABASE_URL"];`);
    expect(kinds()).toEqual(["database-migrations-missing migrations: prisma"]);
    rmSync(path.join(root, "apps/shop/lib/db.ts"));
    writeApp(manifest());
    expect(kinds()).toEqual([]);
  });

  it("reports prisma or drizzle migrations with no schema or config for the migrator to run", () => {
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    put("apps/shop/lib/db.ts", `export const url = process.env.DATABASE_URL;`);
    writeApp(manifest({ database: { engine: "postgres", migrations: "prisma" } }));
    // a schema under test/ or a non-schema file doesn't count
    put("apps/shop/test/schema.prisma", `datasource db { url = env("DATABASE_URL") }`);
    put("apps/shop/prisma/schema.prisma.bak", `datasource db { url = env("DATABASE_URL") }`);
    expect(kinds()).toEqual(["database-migrations-missing migrations: prisma"]);
    expect(json().reviews[0]!.findings[0]).toEqual({
      app: "shop",
      kind: "database-migrations-missing",
      subject: "migrations: prisma",
      message:
        'the manifest says database.migrations: "prisma", so the platform migrates the database with prisma migrate deploy, but there is no *.prisma schema in the app, so the command fails and installing the app stops at its migrations (add it to the app, or declare the migrations the app really uses)',
    });
    expect(review().lines.join("\n")).toMatch(
      /\[database-migrations-missing\] the manifest says database\.migrations: "prisma"/,
    );
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);

    // a schema anywhere in the app's source, also in the multi-file layout, is enough
    put("apps/shop/prisma/schema/base.prisma", `datasource db {\n  url = env("DATABASE_URL")\n}`);
    expect(kinds()).toEqual([]);

    // drizzle needs drizzle.config.* at the app's root; one in a subfolder doesn't count
    writeApp(manifest({ database: { engine: "postgres", migrations: "drizzle" } }));
    put("apps/shop/lib/drizzle.config.ts", `export default {};`);
    expect(kinds()).toEqual(["database-migrations-missing migrations: drizzle"]);
    expect(json().reviews[0]!.findings[0]).toMatchObject({
      message: expect.stringContaining("with drizzle-kit migrate, but there is no drizzle.config.* at the app's root"),
    });
    put("apps/shop/drizzle.config.mts", `export default {};`);
    expect(kinds()).toEqual([]);

    // sql migrations have no standard command, and engine "none" has nothing to migrate
    rmSync(path.join(root, "apps/shop/drizzle.config.mts"));
    writeApp(manifest({ database: { engine: "postgres", migrations: "sql" } }));
    expect(kinds()).toEqual([]);
    writeApp(manifest({ secrets: ["DATABASE_URL"] }));
    expect(kinds()).toEqual([]);
  });

  it("reports a worker named like the compose file's web service or migrator", () => {
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    const worker = (name: string) => ({
      name,
      image: "shop-worker",
      network: "internal",
      resources: { memory: "128m", cpus: 0.25 },
    });
    const withWorkers = (...names: string[]) => {
      const m = manifest();
      return { ...m, runtime: { ...m.runtime, workers: names.map(worker) } };
    };
    writeApp(withWorkers("mailer", "web", "migrate"));
    expect(kinds()).toEqual(["worker-name-reserved worker: web", "worker-name-reserved worker: migrate"]);
    expect(json().reviews[0]!.findings[0]).toEqual({
      app: "shop",
      kind: "worker-name-reserved",
      subject: "worker: web",
      message:
        "the worker \"web\" has the name of the compose file's web service, so platform compose refuses to write the app's compose file and the app can't be deployed (rename the worker)",
    });
    expect(json().reviews[0]!.findings[1]).toMatchObject({
      message: expect.stringContaining("the name of the compose file's migrator"),
    });
    expect(review().lines.join("\n")).toMatch(/\[worker-name-reserved\] the worker "web"/);
    expect(review(["--markdown"]).lines[0]!).toContain("| worker-name-reserved | worker: web |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);

    // the review and compose refuse the same names
    expect([...RESERVED_SERVICE_NAMES].sort()).toEqual(["migrate", "web"]);

    // other names, also ones that only contain a reserved name, are fine
    writeApp(withWorkers("mailer", "web-sync", "migrator"));
    expect(kinds()).toEqual([]);
  });

  it("reports a host that another app in this repo also claims", () => {
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    writeApp(
      manifest({ domains: { primary: "shop.example.com", aliases: ["www.shop.example.com", "store.example.com"] } }),
    );
    // billing takes shop's alias as its primary; crm lists shop's primary as an alias; blog has its own host
    writeOtherApp("billing", { primary: "www.shop.example.com" });
    writeOtherApp("crm", { primary: "crm.example.com", aliases: ["shop.example.com"] });
    writeOtherApp("blog");
    // only shop is reviewed, but every app's manifest is read for its hosts
    expect(kinds(["shop"])).toEqual([
      "domain-claimed-twice host: shop.example.com",
      "domain-claimed-twice host: www.shop.example.com",
    ]);
    const found = (JSON.parse(review(["shop", "--json"]).lines[0]!) as { reviews: AppReview[] }).reviews[0]!.findings;
    expect(found[0]).toEqual({
      app: "shop",
      kind: "domain-claimed-twice",
      subject: "host: shop.example.com",
      file: "apps/shop/platform.app.json",
      message:
        "the host shop.example.com (its domains.primary) is also claimed by crm in this repo, but the gateway sends a host to one app only, so every request to it reaches one of them and the other is unreachable at that host (give each app its own domain)",
    });
    expect(found[1]!.message).toMatch(
      /^the host www\.shop\.example\.com \(a domains\.aliases entry\) is also claimed by billing /,
    );
    // each side of a clash is reported
    expect(kinds(["billing"])).toEqual(["domain-claimed-twice host: www.shop.example.com"]);
    expect(kinds(["crm"])).toEqual(["domain-claimed-twice host: shop.example.com"]);
    expect(kinds(["blog"])).toEqual([]);
    expect(review(["shop"]).lines.join("\n")).toMatch(/\[domain-claimed-twice\] the host shop\.example\.com/);
    expect(review(["shop", "--markdown"]).lines[0]!).toContain("| domain-claimed-twice | host: shop.example.com |");
    expect(review(["shop"]).ok).toBe(true);
    expect(review(["shop", "--strict"]).ok).toBe(false);
  });

  it("counts an app's default host, names every other claimant, and skips invalid manifests", () => {
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    writeApp(manifest());
    writeOtherApp("billing", { primary: "shop.asafarim.site" });
    writeOtherApp("crm", { primary: "crm.example.com", aliases: ["shop.asafarim.site"] });
    // an invalid manifest claims nothing
    put("apps/broken/platform.app.json", JSON.stringify({ id: "broken", domains: { primary: "shop.asafarim.site" } }));
    expect(kinds(["shop"])).toEqual(["domain-claimed-twice host: shop.asafarim.site"]);
    const messages = (id: string) =>
      (JSON.parse(review([id, "--json"]).lines[0]!) as { reviews: AppReview[] }).reviews[0]!.findings.map(
        (f) => f.message,
      );
    expect(messages("shop")[0]).toMatch(
      /^the host shop\.asafarim\.site \(its default host, as it has no domains\.primary\) is also claimed by billing, crm in this repo/,
    );
    // billing sees the same clash from its side, naming both others (in folder order)
    expect(kinds(["billing"])).toEqual(["domain-claimed-twice host: shop.asafarim.site"]);
    expect(messages("billing")[0]).toMatch(/\(its domains\.primary\) is also claimed by crm, shop in this repo/);
    // once shop has a primary of its own, its default host is no longer its: only billing and crm still clash
    writeApp(manifest({ domains: { primary: "shop.example.com" } }));
    expect(kinds(["shop", "billing"])).toEqual(["domain-claimed-twice host: shop.asafarim.site"]);
  });

  it("reports a manifest copied to a second folder without a new id", () => {
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    writeApp(manifest({ domains: { primary: "shop.example.com" } }));
    // apps/shop-copy holds a copy of shop's manifest, id and all
    put("apps/shop-copy/platform.app.json", JSON.stringify(manifest({ domains: { primary: "shop.example.com" } })));
    put("apps/shop-copy/app/api/health/route.ts", "export function GET() {}");
    put("apps/shop-copy/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    expect(kinds(["shop", "shop-copy"])).toEqual([
      "domain-claimed-twice host: shop.example.com",
      "domain-claimed-twice host: shop.example.com",
    ]);
    const messages = (
      JSON.parse(review(["shop", "shop-copy", "--json"]).lines[0]!) as { reviews: AppReview[] }
    ).reviews.map((r) => r.findings[0]!.message);
    expect(messages[0]).toMatch(/is also claimed by shop \(apps\/shop-copy\) in this repo/);
    expect(messages[1]).toMatch(/is also claimed by shop in this repo/);
    // the file says which folder each finding is about, also when both apps have the same id
    const files = (
      JSON.parse(review(["shop", "shop-copy", "--json"]).lines[0]!) as { reviews: AppReview[] }
    ).reviews.map((r) => r.findings[0]!.file);
    expect(files).toEqual(["apps/shop/platform.app.json", "apps/shop-copy/platform.app.json"]);
  });

  it("reports a secret named like a database variable of the compose file", () => {
    put(
      "apps/shop/lib/x.ts",
      `"shop.orders.read"; "shop.orders.write"; process.env.DATABASE_URL; process.env.SHOP_DATABASE_URL; process.env.SHOP_MIGRATOR_DATABASE_URL; process.env.STRIPE_KEY;`,
    );
    const postgres = { engine: "postgres", migrations: "sql" };
    const secrets = ["STRIPE_KEY", "DATABASE_URL", "SHOP_DATABASE_URL", "SHOP_MIGRATOR_DATABASE_URL"];
    writeApp(manifest({ database: postgres, secrets }));
    expect(kinds()).toEqual([
      "secret-name-reserved secret: DATABASE_URL",
      "secret-name-reserved secret: SHOP_DATABASE_URL",
      "secret-name-reserved secret: SHOP_MIGRATOR_DATABASE_URL",
    ]);
    expect(json().reviews[0]!.findings[0]).toEqual({
      app: "shop",
      kind: "secret-name-reserved",
      subject: "secret: DATABASE_URL",
      message:
        "the secret DATABASE_URL has the name of the database URL the platform hands the app in the generated compose file, so platform compose refuses to write the app's compose file and the app can't be deployed (rename the secret, or drop it: the platform provisions the database)",
    });
    expect(json().reviews[0]!.findings[1]).toMatchObject({
      message: expect.stringContaining("the name of the web service's and workers' database URL"),
    });
    expect(json().reviews[0]!.findings[2]).toMatchObject({
      message: expect.stringContaining("the name of the migrator's database URL"),
    });
    expect(review().lines.join("\n")).toMatch(/\[secret-name-reserved\] the secret DATABASE_URL/);
    expect(review(["--markdown"]).lines[0]!).toContain("| secret-name-reserved | secret: DATABASE\\_URL |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);

    // the review and compose refuse the same names: each one alone stops the compose file
    const pinned = `shop@sha256:${"a".repeat(64)}`;
    const compose = (names: string[]) =>
      buildCompose(manifest({ database: postgres, secrets: names }) as never, {
        env: "prod",
        image: pinned,
        migrateCommand: ["migrate"],
      }).ok;
    expect(compose(["STRIPE_KEY"])).toBe(true);
    for (const name of secrets.slice(1)) expect(compose(["STRIPE_KEY", name])).toBe(false);

    // with engine "none" the app may bring its own DATABASE_URL, and other apps' names are fine
    writeApp(manifest({ secrets: ["DATABASE_URL", "STRIPE_KEY"] }));
    expect(kinds()).toEqual([]);
    put(
      "apps/shop/lib/x.ts",
      `"shop.orders.read"; "shop.orders.write"; process.env.DATABASE_URL; process.env.OTHER_DATABASE_URL;`,
    );
    writeApp(manifest({ database: postgres, secrets: ["OTHER_DATABASE_URL"] }));
    expect(kinds()).toEqual([]);
  });
  it("reports config keys and secrets that share one APP_CONFIG_ variable", () => {
    const code = `"shop.orders.read"; "shop.orders.write"; config.getInt("limits.maxNotes"); config.getInt("limitsMax.notes"); config.getString("theme"); process.env.APP_CONFIG_THEME;`;
    put("apps/shop/lib/x.ts", code);
    const config = [
      { key: "limits.maxNotes", type: "int", default: 10 },
      { key: "limitsMax.notes", type: "int", default: 20 },
      { key: "theme", type: "string", default: "light" },
    ];
    writeApp(manifest({ config, secrets: ["APP_CONFIG_THEME"] }));
    expect(kinds()).toEqual([
      "config-variable-clash variable: APP_CONFIG_LIMITS_MAX_NOTES",
      "config-variable-clash variable: APP_CONFIG_THEME",
    ]);
    expect(json().reviews[0]!.findings[0]).toEqual({
      app: "shop",
      kind: "config-variable-clash",
      subject: "variable: APP_CONFIG_LIMITS_MAX_NOTES",
      message:
        "the config keys limits.maxNotes and limitsMax.notes read the same variable, APP_CONFIG_LIMITS_MAX_NOTES, so setting it sets every one of them and they can't have different values (rename all but one of the keys)",
    });
    expect(json().reviews[0]!.findings[1]).toEqual({
      app: "shop",
      kind: "config-variable-clash",
      subject: "variable: APP_CONFIG_THEME",
      message:
        "the secret APP_CONFIG_THEME has the name of the variable the config key theme reads its value from, so the secret's value is read as config, and the app throws when it starts if that value isn't of the key's type (rename the secret)",
    });
    expect(review().lines.join("\n")).toMatch(/\[config-variable-clash\] the config keys limits\.maxNotes/);
    expect(review(["--markdown"]).lines[0]!).toContain("| config-variable-clash | variable: APP\\_CONFIG\\_THEME |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);

    // a secret clashing with two keys at once is one finding, naming both keys
    writeApp(manifest({ config: config.slice(0, 2), secrets: ["APP_CONFIG_LIMITS_MAX_NOTES"] }));
    put(
      "apps/shop/lib/x.ts",
      `"shop.orders.read"; "shop.orders.write"; config.getInt("limits.maxNotes"); config.getInt("limitsMax.notes"); process.env.APP_CONFIG_LIMITS_MAX_NOTES;`,
    );
    expect(kinds()).toEqual(["config-variable-clash variable: APP_CONFIG_LIMITS_MAX_NOTES"]);
    expect(json().reviews[0]!.findings[0]).toMatchObject({
      message: expect.stringMatching(
        /^the secret APP_CONFIG_LIMITS_MAX_NOTES has the name of the variable the config keys limits\.maxNotes and limitsMax\.notes read their values from/,
      ),
    });

    // keys and secrets with variables of their own are fine, also ones that only look alike
    put(
      "apps/shop/lib/x.ts",
      `"shop.orders.read"; "shop.orders.write"; config.getInt("limits.maxNotes"); config.getInt("limits.max"); config.getString("theme"); process.env.APP_CONFIG_THEMES; process.env.THEME;`,
    );
    writeApp(
      manifest({
        config: [config[0], config[2], { key: "limits.max", type: "int", default: 1 }],
        secrets: ["APP_CONFIG_THEMES", "THEME"],
      }),
    );
    expect(kinds()).toEqual([]);
  });

  it("reports an event type events.subscribes lists more than once", () => {
    const code = `"shop.orders.read"; "shop.orders.write"; "billing.invoice.paid.v1"; "billing.invoice.void.v1";`;
    put("apps/shop/lib/x.ts", code);
    const sub = (type: string, handler: string) => ({ type, handler });
    writeApp(
      manifest({
        events: {
          subscribes: [
            sub("billing.invoice.paid.v1", "/events/paid"),
            sub("billing.invoice.void.v1", "/events/void"),
            sub("billing.invoice.paid.v1", "/events/paid-v2"),
            sub("billing.invoice.void.v1", "/events/void"),
          ],
        },
      }),
    );
    expect(kinds()).toEqual([
      "subscription-declared-twice subscription: billing.invoice.paid.v1",
      "subscription-declared-twice subscription: billing.invoice.void.v1",
    ]);
    expect(json().reviews[0]!.findings[0]).toEqual({
      app: "shop",
      kind: "subscription-declared-twice",
      subject: "subscription: billing.invoice.paid.v1",
      file: "apps/shop/platform.app.json",
      message:
        "events.subscribes lists billing.invoice.paid.v1 2 times (handlers /events/paid and /events/paid-v2), but core-api keeps one subscription per app and event type, so registering the app fails and it can't be installed or upgraded (keep one subscription for the type, with one handler)",
    });
    expect(json().reviews[0]!.findings[1]).toMatchObject({
      message: expect.stringMatching(
        /^events\.subscribes lists billing\.invoice\.void\.v1 2 times \(each with the handler \/events\/void\)/,
      ),
    });
    expect(review().lines.join("\n")).toMatch(
      /\[subscription-declared-twice\] events\.subscribes lists billing\.invoice\.paid\.v1/,
    );
    expect(review(["--markdown"]).lines[0]!).toContain(
      "| subscription-declared-twice | subscription: billing.invoice.paid.v1 |",
    );
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);

    // the manifest schema accepts the repeat, which is why the review reports it
    expect(
      validateManifest(
        manifest({
          events: { subscribes: [sub("billing.invoice.paid.v1", "/a"), sub("billing.invoice.paid.v1", "/b")] },
        }),
      ).ok,
    ).toBe(true);

    // each type once, also other versions of the same type: nothing to report
    writeApp(
      manifest({
        events: {
          subscribes: [
            sub("billing.invoice.paid.v1", "/events/paid"),
            sub("billing.invoice.paid.v2", "/events/paid"),
            sub("billing.invoice.void.v1", "/events/void"),
          ],
        },
      }),
    );
    put("apps/shop/lib/x.ts", `${code} "billing.invoice.paid.v2";`);
    expect(kinds()).toEqual([]);
  });

  it("reports a Dockerfile PORT other than runtime.port", () => {
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    writeApp(manifest());
    put(
      "apps/shop/Dockerfile",
      "FROM node:22 AS build\nENV PORT=3000\nFROM node:22-slim\nENV NODE_ENV=production PORT=8080\n",
    );
    expect(kinds()).toEqual(["runtime-port-mismatch PORT=8080"]);
    expect(json().reviews[0]!.findings[0]).toEqual({
      app: "shop",
      kind: "runtime-port-mismatch",
      subject: "PORT=8080",
      file: "apps/shop/Dockerfile",
      message:
        "the Dockerfile sets ENV PORT=8080, but the manifest says runtime.port: 3000, which the gateway and the compose file reach the web service on, so the server listens on the wrong port and every request through the gateway fails (make them the same)",
    });
    expect(review().lines.join("\n")).toMatch(/\[runtime-port-mismatch\] the Dockerfile sets ENV PORT=8080/);
    expect(review(["--markdown"]).lines[0]!).toContain("| runtime-port-mismatch | PORT=8080 |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);

    // the same port, a non-literal value, no PORT at all, or no root Dockerfile: nothing to report
    for (const text of [
      "FROM node\nENV PORT 3000\n",
      "FROM node\nARG PORT=8080\nENV PORT=${PORT}\n",
      "FROM node\nEXPOSE 8080\n",
    ]) {
      put("apps/shop/Dockerfile", text);
      expect(kinds()).toEqual([]);
    }
    rmSync(path.join(root, "apps/shop/Dockerfile"));
    put("apps/shop/docker/Dockerfile", "FROM node\nENV PORT=8080\n");
    expect(kinds()).toEqual([]);
  });
});

describe("platform manifest review: route-permissions-stacked", () => {
  const roles = [
    { key: "shop.viewer", grants: ["shop.orders.read"] },
    { key: "shop.admin", grants: ["shop.orders.write"] },
  ];
  const stacked = [
    { path: "/api/orders/**", permission: "shop.orders.read" },
    { path: "/api/orders/admin/**", permission: "shop.orders.write" },
  ];
  const serve = () => {
    put("apps/shop/lib/x.ts", `"shop.orders.read"; "shop.orders.write";`);
    put("apps/shop/app/api/orders/route.ts", "export function GET() {}");
    put("apps/shop/app/api/orders/admin/route.ts", "export function GET() {} export function POST() {}");
  };
  // other kinds the fixtures below trip over (an unguarded handler, say) aren't this finding's business
  const stacks = () => kinds().filter((k) => k.startsWith("route-permissions-stacked "));

  it("reports overlapping routes whose permissions no single role grants", () => {
    serve();
    writeApp(manifest({ roles, routes: stacked }));
    expect(kinds()).toEqual(["route-permissions-stacked routes: /api/orders/** + /api/orders/admin/**"]);
    expect(json().reviews[0]!.findings[0]).toEqual({
      app: "shop",
      kind: "route-permissions-stacked",
      subject: "routes: /api/orders/** + /api/orders/admin/**",
      file: "apps/shop/platform.app.json",
      message:
        "the routes /api/orders/** (shop.orders.read) and /api/orders/admin/** (shop.orders.write) all match GET /api/orders/admin, and the gateway asks for every matching route's permission, but no role grants shop.orders.read and shop.orders.write together, so a user with only one of those roles gets 403 there (have one role grant them all, or narrow the broader route so they don't overlap)",
    });
    expect(review().lines.join("\n")).toMatch(/\[route-permissions-stacked\] the routes \/api\/orders\/\*\*/);
    expect(review(["--markdown"]).lines[0]!).toContain("| route-permissions-stacked |");
    expect(review().ok).toBe(true);
    expect(review(["--strict"]).ok).toBe(false);
  });

  it("finds the overlap on the method both routes cover", () => {
    serve();
    const routes = [
      { path: "/api/orders/**", methods: ["POST"], permission: "shop.orders.read" },
      { path: "/api/orders/admin", methods: ["GET", "POST"], permission: "shop.orders.write" },
    ];
    writeApp(manifest({ roles, routes }));
    expect(json().reviews[0]!.findings.find((f) => f.kind === "route-permissions-stacked")).toMatchObject({
      message: expect.stringContaining("all match POST /api/orders/admin,"),
    });
  });

  it("leaves alone stacks a role grants together, separate methods or paths, one permission, and hidden paths", () => {
    serve();
    // one role grants both, by name or through <id>.*
    writeApp(manifest({ routes: stacked }));
    expect(stacks()).toEqual([]);
    writeApp(manifest({ roles: [...roles, { key: "shop.owner", grants: ["shop.*"] }], routes: stacked }));
    expect(stacks()).toEqual([]);
    // the same path split by method (as Notes does), or paths that don't overlap
    const split = [
      { path: "/api/orders", methods: ["GET"], permission: "shop.orders.read" },
      { path: "/api/orders", methods: ["POST"], permission: "shop.orders.write" },
      { path: "/api/orders/admin/**", methods: ["GET"], permission: "shop.orders.write" },
    ];
    writeApp(manifest({ roles, routes: split }));
    expect(stacks()).toEqual([]);
    // overlapping routes that ask for the same permission
    writeApp(
      manifest({
        roles,
        routes: [stacked[0], { path: "/api/orders/admin/**", permission: "shop.orders.read" }],
      }),
    );
    expect(stacks()).toEqual([]);
    // the gateway answers 404 on a hidden path before it asks for permissions
    const hidden = [...stacked, { path: "/api/orders/admin/**", expose: false }];
    writeApp(manifest({ roles, routes: hidden }));
    expect(stacks()).toEqual([]);
    // hidden for one method only: the other method still stacks
    writeApp(
      manifest({ roles, routes: [...stacked, { path: "/api/orders/admin/**", methods: ["GET"], expose: false }] }),
    );
    expect(json().reviews[0]!.findings.find((f) => f.kind === "route-permissions-stacked")).toMatchObject({
      message: expect.stringContaining("all match POST /api/orders/admin,"),
    });
  });

  it("reports each set of stacked routes once", () => {
    const routes = [
      { path: "/api/**", permission: "shop.orders.read" },
      { path: "/api/orders/admin/**", permission: "shop.orders.write" },
      { path: "/api/orders/admin/x/*", permission: "shop.orders.read" },
    ];
    const found = stackedRoutes({ id: "shop", roles, routes } as never, [
      "/api/orders/admin",
      "/api/orders/admin/x",
      "/api/orders/admin/x/y",
      "/api/x",
    ]);
    expect(found.map((f) => f.routes.map((r) => r.path).join(" + "))).toEqual([
      "/api/** + /api/orders/admin/**",
      "/api/** + /api/orders/admin/** + /api/orders/admin/x/*",
    ]);
    expect(found[1]).toMatchObject({ method: "GET", path: "/api/orders/admin/x/y" });
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

describe("README findings table", () => {
  it("has one row per finding kind, and no row for a kind review doesn't report", () => {
    const readme = readFileSync(path.join(WORKSPACE, "tools/platform-cli/README.md"), "utf8");
    const section = readme.split("## Manifest review (`manifest review`)")[1]?.split("\n## ")[0] ?? "";
    const rows = [...section.matchAll(/^\| `([^`]+)`\s*\|/gm)].map((m) => m[1]);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows).size).toBe(rows.length);
    expect([...rows].sort()).toEqual([...FINDING_KINDS].sort());
  });
});
