import { generateKeyPairSync } from "node:crypto";
import {
  ACCESS_COOKIE_NAME,
  ACCESS_SESSION_PATH,
  signAccessToken,
  verificationKeyOf,
  type SigningKey,
} from "@asafarim/registry-protocol";
import { describe, expect, it } from "vitest";
import {
  createAppSnapshot,
  createGateway,
  pathForms,
  routeRegex,
  routeVerdict,
  type GatewayApp,
} from "../src/gateway.ts";

const key: SigningKey = { kid: "t1", privateJwk: generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }) };
const NOW = new Date("2026-10-04T12:00:00Z");

const ROUTES = [
  { path: "/api/notes", methods: ["GET" as const], permission: "notes.read" },
  { path: "/api/notes", methods: ["POST" as const], permission: "notes.write" },
  { path: "/api/admin/**", permission: "notes.admin" },
  { path: "/internal/**", expose: false },
];

function gatewayWith(apps: GatewayApp[]) {
  return createGateway({ apps: async () => apps, keys: () => [verificationKeyOf(key)], now: () => NOW });
}
const app = (state: GatewayApp["state"] = "active"): GatewayApp => ({
  id: "notes",
  state,
  manifest: { name: "Notes", routes: ROUTES },
});
const token = (permissions: string[], over: { ttl?: number; audience?: string; now?: Date } = {}) =>
  signAccessToken({
    key,
    subject: "dev-member",
    audience: over.audience ?? "notes",
    permissions,
    ttlSeconds: over.ttl,
    now: over.now ?? NOW,
  }).token;
const cookie = (t: string) => `${ACCESS_COOKIE_NAME}=${t}; other=1`;

const ask = (
  gw: ReturnType<typeof gatewayWith>,
  over: Partial<{ method: string; uri: string; cookie: string; accept: string; appId: string }>,
) => gw.check({ appId: "notes", method: "GET", uri: "/", ...over });

describe("route globs", () => {
  it("* is one segment, ** any depth, and /x/** also matches /x", () => {
    expect(routeRegex("/api/*").test("/api/notes")).toBe(true);
    expect(routeRegex("/api/*").test("/api/notes/1")).toBe(false);
    expect(routeRegex("/api/**").test("/api/notes/1/2")).toBe(true);
    expect(routeRegex("/api/**").test("/api")).toBe(true);
    expect(routeRegex("/api/**").test("/apix")).toBe(false);
    expect(routeRegex("/a.b").test("/axb")).toBe(false); // a '.' is a dot
  });

  it("every reading of a tricky path is checked: encoded, dot segments, doubled slashes, backslashes", () => {
    expect(pathForms("/internal/%2e%2e/x")).toContain("/x");
    expect(pathForms("//internal//x")).toContain("/internal/x");
    expect(pathForms("/a/./b/../c")).toContain("/a/c");
    expect(pathForms("/%69nternal/x")).toContain("/internal/x");
    expect(pathForms("\\internal\\x")).toContain("/internal/x");
    expect(pathForms("/bad%E0%A4%A")).toEqual(["/bad%E0%A4%A"]); // a malformed escape: only the raw form
    for (const evasive of ["/%69nternal/x", "//internal/x", "/foo/../internal/x", "/internal/%2e/x", "/INTERNAL/x"]) {
      const v = routeVerdict(ROUTES, "GET", evasive);
      // /INTERNAL differs only by case: the app's router is case-sensitive too, so it isn't the hidden path.
      expect(v.hidden, evasive).toBe(evasive !== "/INTERNAL/x");
    }
  });

  it("methods narrow a rule", () => {
    expect(routeVerdict(ROUTES, "GET", "/api/notes").permissions).toEqual(["notes.read"]);
    expect(routeVerdict(ROUTES, "POST", "/api/notes").permissions).toEqual(["notes.write"]);
    expect(routeVerdict(ROUTES, "DELETE", "/api/notes").permissions).toEqual([]);
  });
});

describe("the gateway decision", () => {
  it("an inactive, installed-only or uninstalled app: 503, never proxied (page for a browser, JSON otherwise)", async () => {
    for (const state of ["inactive", "installed"] as const) {
      const gw = gatewayWith([app(state)]);
      const page = await ask(gw, { accept: "text/html" });
      expect(page.status).toBe(503);
      expect(page.headers["content-type"]).toMatch(/text\/html/);
      expect(page.body).toContain("Notes is temporarily unavailable");
      const api = await ask(gw, { uri: "/api/notes" });
      expect(api.status).toBe(503);
      expect(JSON.parse(api.body)).toEqual({ error: "app_inactive", state });
    }
    const none = await ask(gatewayWith([]), {});
    expect(none.status).toBe(503);
    expect(JSON.parse(none.body)).toEqual({ error: "app_inactive", state: "not_installed" });
  });

  it("an inactive app is 503 even for a hidden path or with a valid token", async () => {
    const gw = gatewayWith([app("inactive")]);
    expect((await ask(gw, { uri: "/internal/x" })).status).toBe(503);
    expect((await ask(gw, { uri: "/api/notes", cookie: cookie(token(["notes.read"])) })).status).toBe(503);
  });

  it("expose: false paths are 404, even for a holder of every permission", async () => {
    const gw = gatewayWith([app()]);
    const all = cookie(token(["notes.read", "notes.write", "notes.admin"]));
    for (const uri of ["/internal/x", "/internal", "/internal/a/b?x=1", "/%69nternal/x", "//internal/x"]) {
      expect((await ask(gw, { uri, cookie: all })).status, uri).toBe(404);
    }
  });

  it("a path no route marks stays public: 200 with no token", async () => {
    const gw = gatewayWith([app()]);
    for (const uri of ["/", "/api/auth/signin", "/api/health", "/_next/static/x.js"]) {
      expect((await ask(gw, { uri })).status, uri).toBe(200);
    }
    // A method no rule covers is public too (the app re-checks).
    expect((await ask(gw, { method: "DELETE", uri: "/api/notes" })).status).toBe(200);
  });

  it("a marked route without a token: 401 JSON naming the refresh path; a browser page is redirected to it", async () => {
    const gw = gatewayWith([app()]);
    const api = await ask(gw, { uri: "/api/notes" });
    expect(api.status).toBe(401);
    expect(JSON.parse(api.body)).toEqual({ error: "unauthenticated", refresh: ACCESS_SESSION_PATH });

    const nav = await ask(gw, { uri: "/api/notes?page=2", accept: "text/html,application/xhtml+xml" });
    expect(nav.status).toBe(302);
    expect(nav.headers.location).toBe(`${ACCESS_SESSION_PATH}?next=${encodeURIComponent("/api/notes?page=2")}`);
  });

  it("an expired token is 401 token_expired; a token for another app or a forged one is invalid_token", async () => {
    const gw = gatewayWith([app()]);
    const old = token(["notes.read"], { now: new Date(NOW.getTime() - 120_000) });
    expect(JSON.parse((await ask(gw, { uri: "/api/notes", cookie: cookie(old) })).body).error).toBe("token_expired");
    const other = token(["notes.read"], { audience: "tasks" });
    expect(JSON.parse((await ask(gw, { uri: "/api/notes", cookie: cookie(other) })).body).error).toBe("invalid_token");
    const forged = `${token(["notes.read"]).slice(0, -4)}AAAA`;
    expect(JSON.parse((await ask(gw, { uri: "/api/notes", cookie: cookie(forged) })).body).error).toBe("invalid_token");
  });

  it("a valid token without the permission: 403 naming it; with it: 200", async () => {
    const gw = gatewayWith([app()]);
    const viewer = cookie(token(["notes.read"]));
    expect((await ask(gw, { uri: "/api/notes", cookie: viewer })).status).toBe(200);
    const denied = await ask(gw, { method: "POST", uri: "/api/notes", cookie: viewer });
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body)).toEqual({ error: "forbidden", permission: "notes.write" });
    const page = await ask(gw, { uri: "/api/admin/users", cookie: viewer, accept: "text/html" });
    expect(page.status).toBe(403);
    expect(page.body).toContain("<code>notes.admin</code>");
    const editor = cookie(token(["notes.read", "notes.write"]));
    expect((await ask(gw, { method: "POST", uri: "/api/notes", cookie: editor })).status).toBe(200);
  });

  it("an evasive path can't dodge a permission rule", async () => {
    const gw = gatewayWith([app()]);
    const viewer = cookie(token(["notes.read"]));
    for (const uri of ["/api/admin/x", "/api//admin/x", "/api/%61dmin/x", "/api/x/../admin/x"]) {
      expect((await ask(gw, { uri, cookie: viewer })).status, uri).toBe(403);
    }
  });

  it("the token is read from its own cookie only, among others", async () => {
    const gw = gatewayWith([app()]);
    const t = token(["notes.read"]);
    expect((await ask(gw, { uri: "/api/notes", cookie: `a=b; ${ACCESS_COOKIE_NAME}=${t}; c=d` })).status).toBe(200);
    expect((await ask(gw, { uri: "/api/notes", cookie: `session=${t}` })).status).toBe(401);
  });

  it("without a signing key every marked route is refused (fail closed)", async () => {
    const gw = createGateway({ apps: async () => [app()], keys: () => [], now: () => NOW });
    expect((await ask(gw, { uri: "/api/notes", cookie: cookie(token(["notes.read"])) })).status).toBe(401);
  });

  it("escapes the permission and app name in the pages", async () => {
    const gw = gatewayWith([{ id: "notes", state: "inactive", manifest: { name: "<b>x</b>", routes: [] } }]);
    expect((await ask(gw, { accept: "text/html" })).body).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("the app snapshot", () => {
  it("serves one load for a while, reloads after the TTL, and on invalidate", async () => {
    let loads = 0;
    let t = 0;
    const snap = createAppSnapshot(async () => (loads++, []), { ttlMs: 2000, now: () => t });
    await snap.apps();
    await snap.apps();
    expect(loads).toBe(1);
    t = 1999;
    await snap.apps();
    expect(loads).toBe(1);
    t = 2000;
    await snap.apps();
    expect(loads).toBe(2);
    snap.invalidate();
    await snap.apps();
    expect(loads).toBe(3);
  });

  it("never serves a failed load again", async () => {
    let n = 0;
    const snap = createAppSnapshot(async () => {
      if (n++ === 0) throw new Error("db down");
      return [];
    });
    await expect(snap.apps()).rejects.toThrow("db down");
    await expect(snap.apps()).resolves.toEqual([]);
  });
});
