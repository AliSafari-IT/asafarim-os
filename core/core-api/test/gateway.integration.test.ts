/**
 * The access token and the gateway hook end to end over HTTP against a real
 * Postgres (P3.3a): the signed token request, the JWKS, and `/authz/check`
 * answering Caddy's forward_auth, driven by the real lifecycle and grants.
 *
 * Same setup and skip rules as registry.integration.test.ts
 * (CORE_API_TEST_ADMIN_URL; CORE_API_TEST_REQUIRED in CI).
 */
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ACCESS_COOKIE_NAME,
  ACCESS_SESSION_PATH,
  ACCESS_TOKEN_TTL_SECONDS,
  signRequest,
  verifyAccessToken,
  type SigningKey,
} from "@asafarim/registry-protocol";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signRegistration } from "../src/credentials.ts";
import { migrate } from "../src/migrate.ts";
import { appDatabaseNames } from "../src/provision.ts";
import { createAppSnapshot } from "../src/gateway.ts";
import { createRegistry } from "../src/registry.ts";
import { createHandler, loadGatewayApps } from "../src/server.ts";

const ADMIN_URL = process.env.CORE_API_TEST_ADMIN_URL;
if (process.env.CORE_API_TEST_REQUIRED && !ADMIN_URL) throw new Error("CORE_API_TEST_ADMIN_URL must be set");

const run = Date.now().toString(36);
const coreDb = `core_gw_${run}`;
const APP = `gwnotes-${run}`;
const OTHER = `gwcrm-${run}`;
const ADMIN_TOKEN = "t".repeat(40);
const READ = `${APP}.notes.read`;
const WRITE = `${APP}.notes.write`;
const EDITOR = `${APP}.editor`;

const signingKey: SigningKey = {
  kid: "test-key",
  privateJwk: generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }),
};

function manifest(id: string) {
  return {
    id,
    name: "Notes",
    version: "0.1.0",
    platform: ">=0.1 <1",
    owner: "ASafariM Digital",
    runtime: {
      image: id,
      port: 3000,
      health: { live: "/healthz", ready: "/readyz" },
      resources: { memory: "128m", cpus: 0.25 },
    },
    database: { engine: "postgres", migrations: "sql" },
    auth: { client: "oidc", publicPaths: ["/api/health"] },
    permissions: [`${id}.notes.read`, `${id}.notes.write`].map((key) => ({ key, description: key })),
    roles: [
      { key: `${id}.viewer`, grants: [`${id}.notes.read`] },
      { key: `${id}.editor`, grants: [`${id}.notes.read`, `${id}.notes.write`] },
    ],
    routes: [
      { path: "/api/notes", methods: ["GET"], permission: `${id}.notes.read` },
      { path: "/api/notes", methods: ["POST"], permission: `${id}.notes.write` },
      { path: "/internal/**", expose: false },
    ],
    ui: { glyph: "NT", color: "#7c3aed", nav: [], status: "active" },
  };
}

describe.skipIf(!ADMIN_URL)("access token and gateway hook (integration)", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  let clock = new Date();
  const credentials = new Map<string, string>();

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${coreDb}"`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${coreDb}`;
    pool = new pg.Pool({ connectionString: url.href, max: 4 });
    await migrate(pool);
    // A snapshot with the production TTL (2 s): the lifecycle tests prove invalidation, not the timer.
    const snapshot = createAppSnapshot(() => loadGatewayApps(pool));
    const registry = createRegistry({
      pool,
      provisioner: async () => {
        const c = new pg.Client({ connectionString: ADMIN_URL });
        await c.connect();
        return c;
      },
      appDatabaseHost: { host: url.hostname, port: Number(url.port) },
      tokenKey: signingKey,
      onLifecycleChange: () => snapshot.invalidate(),
      now: () => clock,
    });
    server = createServer(
      createHandler({
        registry,
        pool,
        adminToken: ADMIN_TOKEN,
        log: () => {},
        tokenKey: signingKey,
        snapshot,
        now: () => clock,
      }),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    for (const id of [APP, OTHER]) {
      const res = await adminReq("POST", `/admin/v1/apps/${id}/install`, manifest(id));
      credentials.set(id, ((await res.json()) as { credential: string }).credential);
      // Roles and permissions exist once the app has self-registered (install alone declares none).
      const body = JSON.stringify(manifest(id));
      const headers = signRegistration({ appId: id, credential: credentials.get(id)!, body, now: clock });
      const reg = await fetch(`${base}/registry/v1/apps/${id}`, { method: "POST", headers, body });
      expect(reg.status).toBe(200);
    }
  });

  afterAll(async () => {
    server?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${coreDb}"`);
      for (const id of [APP, OTHER]) {
        const { database, role } = appDatabaseNames(id);
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      }
      await admin.end();
    }
  });

  const adminReq = (method: string, path: string, body?: unknown, token = ADMIN_TOKEN) =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const lifecycle = (id: string, action: "activate" | "deactivate") =>
    adminReq("POST", `/admin/v1/apps/${id}/${action}`);
  const grant = (role: string, sub: string) => adminReq("PUT", `/admin/v1/roles/${role}/grants/${sub}`);
  const revoke = (role: string, sub: string) => adminReq("DELETE", `/admin/v1/roles/${role}/grants/${sub}`);

  const tokenPath = (sub: string, id = APP) => `/registry/v1/apps/${id}/subjects/${encodeURIComponent(sub)}/token`;
  async function mint(sub: string, opts: { id?: string; signedFor?: string; credential?: string } = {}) {
    const id = opts.id ?? APP;
    const headers = signRequest({
      credential: opts.credential ?? credentials.get(id)!,
      method: "POST",
      path: tokenPath(opts.signedFor ?? sub, id),
      now: clock,
    });
    const res = await fetch(`${base}${tokenPath(sub, id)}`, { method: "POST", headers });
    return { status: res.status, body: (await res.json()) as { token?: string; error?: string; expiresIn?: number } };
  }

  /** What Caddy's forward_auth sends for a request to the app's host. */
  async function authz(opts: { uri: string; method?: string; token?: string; accept?: string; app?: string }) {
    const res = await fetch(`${base}/authz/check`, {
      redirect: "manual",
      headers: {
        "x-asafarim-app": opts.app ?? APP,
        "x-forwarded-method": opts.method ?? "GET",
        "x-forwarded-uri": opts.uri,
        ...(opts.token ? { cookie: `${ACCESS_COOKIE_NAME}=${opts.token}` } : {}),
        ...(opts.accept ? { accept: opts.accept } : {}),
      },
    });
    const text = await res.text();
    return { status: res.status, location: res.headers.get("location"), text };
  }
  const json = (t: string) => JSON.parse(t) as Record<string, unknown>;

  it("an installed app isn't served: the hook says 503, and no token is issued", async () => {
    expect((await authz({ uri: "/" })).status).toBe(503);
    const r = await mint("dev-member");
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("app_inactive");
  });

  it("activating serves the app AT ONCE (no restart, no wait); deactivating stops it at once", async () => {
    expect((await authz({ uri: "/api/health" })).status).toBe(503);
    expect((await lifecycle(APP, "activate")).status).toBe(200);
    expect((await authz({ uri: "/api/health" })).status).toBe(200);
    expect((await lifecycle(APP, "deactivate")).status).toBe(200);
    const off = await authz({ uri: "/api/health", accept: "text/html" });
    expect(off.status).toBe(503);
    expect(off.text).toContain("temporarily unavailable");
    expect((await lifecycle(APP, "activate")).status).toBe(200);
  });

  it("the token is verified by the published JWKS, is for this app and this person, and carries their permissions", async () => {
    await grant(EDITOR, "dev-member");
    const { status, body } = await mint("dev-member");
    expect(status).toBe(200);
    expect(body.expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);

    const jwks = (await (await fetch(`${base}/.well-known/jwks.json`)).json()) as { keys: Record<string, unknown>[] };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).not.toHaveProperty("d"); // never the private half
    const keys = jwks.keys.map((k) => ({
      kid: k.kid as string,
      publicJwk: { kty: "OKP", crv: "Ed25519", x: k.x as string },
    }));
    const verified = verifyAccessToken(body.token!, { keys, audience: APP, now: clock });
    expect(verified).toMatchObject({ ok: true, claims: { sub: "dev-member", aud: APP, perms: [READ, WRITE] } });
    expect(verifyAccessToken(body.token!, { keys, audience: OTHER, now: clock })).toMatchObject({ ok: false });
    await revoke(EDITOR, "dev-member");
  });

  it("a person with no role gets a valid token with no permissions (so 403, not 401)", async () => {
    const { body } = await mint("nobody");
    const r = await authz({ uri: "/api/notes", token: body.token });
    expect(r.status).toBe(403);
    expect(json(r.text)).toEqual({ error: "forbidden", permission: READ });
  });

  it("the token request is signed and bound to the subject, the method and the app", async () => {
    expect((await mint("user-b", { signedFor: "user-a" })).body.error).toBe("bad_signature");
    // A GET signature isn't a POST signature.
    const get = signRequest({
      credential: credentials.get(APP)!,
      method: "GET",
      path: tokenPath("user-b"),
      now: clock,
    });
    expect(
      json(await (await fetch(`${base}${tokenPath("user-b")}`, { method: "POST", headers: get })).text()).error,
    ).toBe("bad_signature");
    // Another app's credential can't mint for this app.
    expect((await mint("user-b", { credential: credentials.get(OTHER)! })).body.error).toBe("bad_signature");
    // Unsigned, and a replayed request.
    const unsigned = await fetch(`${base}${tokenPath("user-b")}`, { method: "POST" });
    expect(json(await unsigned.text()).error).toBe("missing_signature");
    const headers = signRequest({
      credential: credentials.get(APP)!,
      method: "POST",
      path: tokenPath("user-b"),
      now: clock,
    });
    expect((await fetch(`${base}${tokenPath("user-b")}`, { method: "POST", headers })).status).toBe(200);
    const replay = await fetch(`${base}${tokenPath("user-b")}`, { method: "POST", headers });
    expect(json(await replay.text()).error).toBe("replayed_signature");
  });

  it("a token for one app is refused by another app's hook", async () => {
    await lifecycle(OTHER, "activate");
    const { body } = await mint("dev-member");
    const r = await authz({ uri: "/api/notes", token: body.token, app: OTHER });
    expect(r.status).toBe(401);
    expect(json(r.text).error).toBe("invalid_token");
    await lifecycle(OTHER, "deactivate");
  });

  it("the gateway's answers: public 200, no token 401 (page → 302 to the session endpoint), viewer/editor, hidden 404", async () => {
    await grant(`${APP}.viewer`, "viewer-1");
    await grant(EDITOR, "editor-1");
    const viewer = (await mint("viewer-1")).body.token;
    const editor = (await mint("editor-1")).body.token;

    expect((await authz({ uri: "/" })).status).toBe(200); // not marked: public, the app decides
    const anon = await authz({ uri: "/api/notes" });
    expect(anon.status).toBe(401);
    expect(json(anon.text)).toEqual({ error: "unauthenticated", refresh: ACCESS_SESSION_PATH });
    const nav = await authz({ uri: "/api/notes", accept: "text/html" });
    expect(nav).toMatchObject({
      status: 302,
      location: `${ACCESS_SESSION_PATH}?next=${encodeURIComponent("/api/notes")}`,
    });

    expect((await authz({ uri: "/api/notes", token: viewer })).status).toBe(200);
    const denied = await authz({ uri: "/api/notes", method: "POST", token: viewer });
    expect(denied.status).toBe(403);
    expect(json(denied.text)).toEqual({ error: "forbidden", permission: WRITE }); // the permission is named
    expect((await authz({ uri: "/api/notes", method: "POST", token: editor })).status).toBe(200);

    expect((await authz({ uri: "/internal/secret", token: editor })).status).toBe(404);
    expect((await authz({ uri: "//internal/secret", token: editor })).status).toBe(404);
    await revoke(`${APP}.viewer`, "viewer-1");
    await revoke(EDITOR, "editor-1");
  });

  it("a revoked grant takes effect within the documented bound: the token's lifetime", async () => {
    await grant(EDITOR, "leaver");
    const old = (await mint("leaver")).body.token;
    expect((await authz({ uri: "/api/notes", method: "POST", token: old })).status).toBe(200);

    await revoke(EDITOR, "leaver"); // the admin revokes now…
    // …a NEW token already lacks the permission,
    const fresh = (await mint("leaver")).body.token;
    expect((await authz({ uri: "/api/notes", method: "POST", token: fresh })).status).toBe(403);
    // …the OLD token still works until it expires (the staleness bound),
    clock = new Date(clock.getTime() + (ACCESS_TOKEN_TTL_SECONDS - 5) * 1000);
    expect((await authz({ uri: "/api/notes", method: "POST", token: old })).status).toBe(200);
    // …and not after.
    clock = new Date(clock.getTime() + 15 * 1000);
    const late = await authz({ uri: "/api/notes", method: "POST", token: old });
    expect(late.status).toBe(401);
    expect(json(late.text).error).toBe("token_expired");
  });

  it("a deactivated app refuses even a valid token at once, and its tokens aren't issued", async () => {
    await grant(EDITOR, "dev-member");
    const t = (await mint("dev-member")).body.token;
    expect((await authz({ uri: "/api/notes", token: t })).status).toBe(200);
    await lifecycle(APP, "deactivate");
    expect((await authz({ uri: "/api/notes", token: t })).status).toBe(503);
    expect((await mint("dev-member")).status).toBe(503);
    await lifecycle(APP, "activate");
    await revoke(EDITOR, "dev-member");
  });

  it("an uninstalled app id is unavailable, not an error", async () => {
    const r = await authz({ uri: "/", app: "ghost" });
    expect(r.status).toBe(503);
    expect(json(r.text)).toEqual({ error: "app_inactive", state: "not_installed" });
  });

  it("the admin view of what the gateway serves needs the admin token", async () => {
    expect((await adminReq("GET", "/admin/v1/gateway/apps", undefined, "wrong")).status).toBe(401);
    const res = await adminReq("GET", "/admin/v1/gateway/apps");
    const apps = ((await res.json()) as { apps: { id: string; serving: boolean }[] }).apps;
    expect(apps.find((a) => a.id === APP)).toMatchObject({ serving: true });
    expect(apps.find((a) => a.id === OTHER)).toMatchObject({ serving: false });
  });
});
