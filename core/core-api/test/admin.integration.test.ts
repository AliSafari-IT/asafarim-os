/**
 * The admin API and the launcher end to end over HTTP against a real Postgres (P3.3b):
 * who may call the admin API (the CLI token, a person with core.admin, nobody else), that
 * EVERY admin action is audited under the right actor, the lists the console reads, and the
 * launcher. Same setup and skip rules as registry.integration.test.ts.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIdentityVerifier } from "../src/admin-auth.ts";
import { signRegistration, signRequest } from "../src/credentials.ts";
import { createAppSnapshot } from "../src/gateway.ts";
import { migrate } from "../src/migrate.ts";
import { appDatabaseNames } from "../src/provision.ts";
import { createRegistry } from "../src/registry.ts";
import { createHandler, loadGatewayApps } from "../src/server.ts";

const ADMIN_URL = process.env.CORE_API_TEST_ADMIN_URL;
if (process.env.CORE_API_TEST_REQUIRED && !ADMIN_URL) throw new Error("CORE_API_TEST_ADMIN_URL must be set");

const run = Date.now().toString(36);
const coreDb = `core_adm_${run}`;
const NOTES = `adnotes-${run}`;
const DOCS = `addocs-${run}`; // a public app
const LOCAL = `adlocal-${run}`; // an app with no database
const STATIC = "t".repeat(40);
const ISSUER = "http://identity.test";
const AUDIENCE = "core-admin";

/** The shapes of the admin API's answers that these tests read. */
interface RoleRow {
  key: string;
  holders: number;
  migrationNeeded: boolean;
  permissions: { key: string; deprecated: boolean }[];
  deprecatedPermissions: string[];
}
interface AppRow {
  id: string;
  name: string;
  state: string;
  system: boolean;
  permissions: number;
  roles: number;
}
interface EventRow {
  id: number;
  actor: string;
  action: string;
  appId: string | null;
}

function manifest(
  id: string,
  over: { launcher?: "public" | "authenticated"; database?: "none" | "postgres"; order?: number } = {},
) {
  return {
    id,
    name: id.toUpperCase(),
    version: "0.1.0",
    platform: ">=0.1 <1",
    owner: "ASafariM Digital",
    runtime: { image: id, port: 3000, health: { live: "/h", ready: "/h" }, resources: { memory: "128m", cpus: 0.25 } },
    database: over.database === "none" ? { engine: "none" } : { engine: "postgres", migrations: "sql" },
    auth: { client: "oidc", publicPaths: [] },
    permissions: [`${id}.notes.read`, `${id}.notes.write`].map((key) => ({ key, description: key })),
    roles: [
      { key: `${id}.viewer`, grants: [`${id}.notes.read`] },
      { key: `${id}.editor`, grants: [`${id}.notes.read`, `${id}.notes.write`] },
    ],
    ui: {
      glyph: id.slice(0, 2).toUpperCase(),
      color: "#7c3aed",
      nav: [],
      status: "active",
      ...(over.launcher
        ? {
            launcher: {
              description: `${id} app`,
              meta: `${id}.example`,
              access: over.launcher,
              order: over.order ?? 10,
            },
          }
        : {}),
    },
  };
}

describe.skipIf(!ADMIN_URL)("the admin API and the launcher (integration)", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  let idKey: Awaited<ReturnType<typeof generateKeyPair>>;
  const credentials = new Map<string, string>();

  const startServer = async (opts: { adminToken?: string }) => {
    const snapshot = createAppSnapshot(() => loadGatewayApps(pool));
    const url = new URL(ADMIN_URL!);
    const registry = createRegistry({
      pool,
      provisioner: async () => {
        const c = new pg.Client({ connectionString: ADMIN_URL });
        await c.connect();
        return c;
      },
      appDatabaseHost: { host: url.hostname, port: Number(url.port) },
      appUrlTemplate: "http://{id}.localhost:8080",
      onLifecycleChange: () => snapshot.invalidate(),
    });
    const jwk = { ...(await exportJWK(idKey.publicKey)), kid: "idk", alg: "ES256", use: "sig" };
    const identity = createIdentityVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: createLocalJWKSet({ keys: [jwk] }),
    });
    const s = createServer(
      createHandler({ registry, pool, adminToken: opts.adminToken, identity, snapshot, log: () => {} }),
    );
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return { s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${coreDb}"`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${coreDb}`;
    pool = new pg.Pool({ connectionString: url.href, max: 4 });
    await migrate(pool);
    idKey = await generateKeyPair("ES256");
    ({ s: server, base } = await startServer({ adminToken: STATIC }));

    // Three apps: a private one, a public one, one without a database.
    for (const [id, over] of [
      [NOTES, { launcher: "authenticated" as const, order: 10 }],
      [DOCS, { launcher: "public" as const, order: 20 }],
      [LOCAL, { database: "none" as const }],
    ] as const) {
      const res = await cli("POST", `/admin/v1/apps/${id}/install`, manifest(id, over));
      credentials.set(id, ((await res.json()) as { credential: string }).credential);
      const body = JSON.stringify(manifest(id, over));
      const headers = signRegistration({ appId: id, credential: credentials.get(id)!, body });
      expect((await fetch(`${base}/registry/v1/apps/${id}`, { method: "POST", headers, body })).status).toBe(200);
    }
  });

  afterAll(async () => {
    server?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${coreDb}"`);
      for (const id of [NOTES, DOCS, LOCAL]) {
        const { database, role } = appDatabaseNames(id);
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      }
      await admin.end();
    }
  });

  const call = (method: string, path: string, authorization: string | undefined, body?: unknown, at = base) =>
    fetch(`${at}${path}`, {
      method,
      headers: { ...(authorization ? { authorization } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  /** The CLI: the static token. */
  const cli = (method: string, path: string, body?: unknown) => call(method, path, `Bearer ${STATIC}`, body);
  const idToken = async (sub: string, over: { aud?: string; exp?: string } = {}) =>
    new SignJWT({ sub })
      .setProtectedHeader({ alg: "ES256", kid: "idk" })
      .setIssuer(ISSUER)
      .setAudience(over.aud ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(over.exp ?? "1h")
      .sign(idKey.privateKey);
  /** A person, through the Admin console: their identity token. */
  const as = async (sub: string, method: string, path: string, body?: unknown) =>
    call(method, path, `Bearer ${await idToken(sub)}`, body);
  const json = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as T;
  const auditOf = async (where: string, params: unknown[]) =>
    (await pool.query(`SELECT actor, action, app_id, detail FROM audit_events WHERE ${where} ORDER BY id`, params))
      .rows;

  it("the built-in core catalog exists from the migration: core.admin, nobody holds it", async () => {
    const roles = await json(await cli("GET", "/admin/v1/roles?app=core"));
    expect(roles.roles).toMatchObject([
      { key: "core.admin", appId: "core", permissions: [{ key: "core.admin", deprecated: false }], holders: 0 },
    ]);
  });

  it("core is built in: it can't be installed, activated or deactivated, and it has no credential", async () => {
    // Installing under the reserved id is refused (and nothing is created).
    const install = await cli("POST", "/admin/v1/apps/core/install", { ...manifest(NOTES), id: "core" });
    expect(install.status).toBe(422);
    expect((await pool.query("SELECT count(*) AS n FROM app_credentials WHERE app_id = 'core'")).rows[0].n).toBe("0");
    for (const action of ["activate", "deactivate"]) {
      const r = await cli("POST", `/admin/v1/apps/core/${action}`);
      expect(r.status).toBe(409);
      expect((await json(r)).error).toBe("invalid_state");
    }
    expect((await json(await cli("GET", "/admin/v1/apps/core"))).state).toBe("active");
    // Nothing can sign for it: an unsigned request is refused.
    expect((await call("GET", "/registry/v1/apps/core/launcher/x", undefined)).status).toBe(401);
  });

  it("an app with no database gets none: no database, no role, a null database in the install answer", async () => {
    const row = (await pool.query("SELECT database_name FROM apps WHERE id = $1", [LOCAL])).rows[0];
    expect(row.database_name).toBeNull();
    const { database, role } = appDatabaseNames(LOCAL);
    expect((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database])).rowCount).toBe(0);
    expect((await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount).toBe(0);
  });

  it("bootstrap: the CLI token grants core.admin to the first admin (audited as 'admin')", async () => {
    const r = await cli("PUT", "/admin/v1/roles/core.admin/grants/dev-admin");
    expect(await json(r)).toEqual({ role: "core.admin", subject: "dev-admin", granted: true });
    expect(await auditOf("action = 'role.granted' AND app_id = 'core'", [])).toEqual([
      expect.objectContaining({ actor: "admin", detail: { role: "core.admin", subject: "dev-admin" } }),
    ]);
  });

  it("who may call: a person with core.admin yes; a person without it 403; no token, a bad token, another audience, an expired token 401", async () => {
    const me = await as("dev-admin", "GET", "/admin/v1/session");
    expect(me.status).toBe(200);
    expect(await json(me)).toEqual({ actor: "user:dev-admin", kind: "user", subject: "dev-admin" });

    const member = await as("dev-member", "GET", "/admin/v1/session");
    expect(member.status).toBe(403);
    expect((await json(member)).error).toBe("forbidden");

    expect((await call("GET", "/admin/v1/session", undefined)).status).toBe(401);
    expect((await call("GET", "/admin/v1/session", "Bearer nonsense")).status).toBe(401);
    expect(
      (await call("GET", "/admin/v1/session", `Bearer ${await idToken("dev-admin", { aud: "notes" })}`)).status,
    ).toBe(401);
    expect(
      (await call("GET", "/admin/v1/session", `Bearer ${await idToken("dev-admin", { exp: "-10m" })}`)).status,
    ).toBe(401);
    // …and the member can't use ANY admin endpoint
    for (const [m, p] of [
      ["GET", "/admin/v1/apps"],
      ["GET", "/admin/v1/audit"],
      ["POST", `/admin/v1/apps/${NOTES}/activate`],
      ["PUT", `/admin/v1/roles/${NOTES}.editor/grants/dev-member`],
    ] as const) {
      expect((await as("dev-member", m, p)).status, `${m} ${p}`).toBe(403);
    }
  });

  it("every admin action by a person is audited under THEIR name: activate, grant, revoke, deactivate", async () => {
    expect((await as("dev-admin", "POST", `/admin/v1/apps/${NOTES}/activate`)).status).toBe(200);
    expect((await as("dev-admin", "PUT", `/admin/v1/roles/${NOTES}.editor/grants/dev-member`)).status).toBe(200);
    expect((await as("dev-admin", "DELETE", `/admin/v1/roles/${NOTES}.editor/grants/dev-member`)).status).toBe(200);
    expect((await as("dev-admin", "PUT", `/admin/v1/roles/${NOTES}.viewer/grants/dev-member`)).status).toBe(200);
    expect((await as("dev-admin", "POST", `/admin/v1/apps/${NOTES}/deactivate`)).status).toBe(200);
    expect((await as("dev-admin", "POST", `/admin/v1/apps/${NOTES}/activate`)).status).toBe(200);

    const rows = await auditOf("actor = 'user:dev-admin' AND app_id = $1", [NOTES]);
    expect(rows.map((r) => r.action)).toEqual([
      "app.activated",
      "role.granted",
      "role.revoked",
      "role.granted",
      "app.deactivated",
      "app.activated",
    ]);
    expect(rows[1]!.detail).toEqual({ role: `${NOTES}.editor`, subject: "dev-member" });
    // and nothing was recorded under the CLI's name for those
    expect(await auditOf("actor = 'admin' AND action = 'app.activated' AND app_id = $1", [NOTES])).toEqual([]);
  });

  it("a refused call writes no audit event (a 403 can't change anything)", async () => {
    const before = Number((await pool.query("SELECT count(*) AS n FROM audit_events")).rows[0].n);
    await as("dev-member", "POST", `/admin/v1/apps/${DOCS}/activate`);
    await call("POST", `/admin/v1/apps/${DOCS}/activate`, undefined);
    expect(Number((await pool.query("SELECT count(*) AS n FROM audit_events")).rows[0].n)).toBe(before);
    expect((await json(await cli("GET", `/admin/v1/apps/${DOCS}`))).state).toBe("installed");
  });

  it("an admin can't revoke their OWN core.admin; another admin can; a revoked admin is refused at once", async () => {
    await cli("PUT", "/admin/v1/roles/core.admin/grants/dev-owner");
    const self = await as("dev-admin", "DELETE", "/admin/v1/roles/core.admin/grants/dev-admin");
    expect(self.status).toBe(409);
    expect((await json(self)).error).toBe("invalid_state");
    const holders = await json<{ grants: { subject: string }[] }>(
      await cli("GET", "/admin/v1/roles/core.admin/grants"),
    );
    expect(holders.grants.map((g) => g.subject)).toContain("dev-admin");

    const token = await idToken("dev-owner");
    expect((await call("GET", "/admin/v1/session", `Bearer ${token}`)).status).toBe(200);
    expect((await as("dev-admin", "DELETE", "/admin/v1/roles/core.admin/grants/dev-owner")).status).toBe(200);
    // the SAME, still-valid identity token no longer works: core.admin is checked per request
    expect((await call("GET", "/admin/v1/session", `Bearer ${token}`)).status).toBe(403);
  });

  it("lists: apps (core first, flagged built in, with states), roles with holders, a person's grants, a role's holders", async () => {
    const apps = (await json<{ apps: AppRow[] }>(await as("dev-admin", "GET", "/admin/v1/apps"))).apps;
    expect(apps[0]).toMatchObject({ id: "core", system: true, state: "active" });
    expect(apps.find((a) => a.id === NOTES)).toMatchObject({
      name: NOTES.toUpperCase(),
      state: "active",
      system: false,
      permissions: 2,
      roles: 2,
    });
    expect(apps.find((a) => a.id === DOCS)).toMatchObject({ state: "installed" });

    const roles = (await json<{ roles: RoleRow[] }>(await as("dev-admin", "GET", `/admin/v1/roles?app=${NOTES}`)))
      .roles;
    expect(roles.map((r) => r.key)).toEqual([`${NOTES}.editor`, `${NOTES}.viewer`]);
    expect(roles.find((r) => r.key === `${NOTES}.viewer`)).toMatchObject({ holders: 1, migrationNeeded: false });
    expect(roles.find((r) => r.key === `${NOTES}.editor`)!.permissions.map((p) => p.key)).toEqual([
      `${NOTES}.notes.read`,
      `${NOTES}.notes.write`,
    ]);

    const grants = await json<{ grants: unknown[] }>(
      await as("dev-admin", "GET", "/admin/v1/subjects/dev-member/grants"),
    );
    expect(grants.grants).toMatchObject([{ role: `${NOTES}.viewer`, appId: NOTES, granted_by: "user:dev-admin" }]);
    expect((await as("dev-admin", "GET", "/admin/v1/subjects/a%2Fb/grants")).status).toBe(400);
    expect((await as("dev-admin", "GET", "/admin/v1/roles?app=Bad%20Id")).status).toBe(400);
  });

  it("a role that still grants a deprecated permission is flagged: migration needed", async () => {
    await pool.query("UPDATE permissions SET deprecated_at = now() WHERE key = $1", [`${NOTES}.notes.write`]);
    const roles = (await json<{ roles: RoleRow[] }>(await as("dev-admin", "GET", `/admin/v1/roles?app=${NOTES}`)))
      .roles;
    const editor = roles.find((r) => r.key === `${NOTES}.editor`)!;
    expect(editor).toMatchObject({ migrationNeeded: true, deprecatedPermissions: [`${NOTES}.notes.write`] });
    expect(editor.permissions.find((p) => p.key === `${NOTES}.notes.write`)).toMatchObject({ deprecated: true });
    expect(roles.find((r) => r.key === `${NOTES}.viewer`)!.migrationNeeded).toBe(false);
    await pool.query("UPDATE permissions SET deprecated_at = NULL WHERE key = $1", [`${NOTES}.notes.write`]);
  });

  it("the audit log: newest first, filtered by app and by actor, paged, with validated parameters", async () => {
    const all = await json<{ events: EventRow[]; next: number | null }>(
      await as("dev-admin", "GET", "/admin/v1/audit?limit=200"),
    );
    const ids = all.events.map((e) => e.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);

    const byApp = await json<{ events: EventRow[]; next: number | null }>(
      await as("dev-admin", "GET", `/admin/v1/audit?app=${NOTES}&limit=200`),
    );
    expect(byApp.events.every((e) => e.appId === NOTES)).toBe(true);
    expect(byApp.events.length).toBeGreaterThanOrEqual(6);

    const byActor = await json<{ events: EventRow[]; next: number | null }>(
      await as("dev-admin", "GET", "/admin/v1/audit?actor=DEV-ADMIN&limit=200"),
    );
    expect(byActor.events.length).toBeGreaterThan(0);
    expect(byActor.events.every((e) => e.actor === "user:dev-admin")).toBe(true);

    const page1 = await json<{ events: EventRow[]; next: number | null }>(
      await as("dev-admin", "GET", `/admin/v1/audit?app=${NOTES}&limit=2`),
    );
    expect(page1.events).toHaveLength(2);
    expect(page1.next).toBe(page1.events[1]!.id);
    const page2 = await json<{ events: EventRow[]; next: number | null }>(
      await as("dev-admin", "GET", `/admin/v1/audit?app=${NOTES}&limit=2&before=${page1.next}`),
    );
    expect(page2.events[0]!.id).toBeLessThan(page1.events[1]!.id);

    // a % or _ in the actor filter matches literally, not as a wildcard
    expect(
      (await json<{ events: EventRow[] }>(await as("dev-admin", "GET", "/admin/v1/audit?actor=%25"))).events,
    ).toEqual([]);
    for (const bad of ["limit=abc", "before=-1", `actor=${"x".repeat(200)}`]) {
      expect((await as("dev-admin", "GET", `/admin/v1/audit?${bad}`)).status, bad).toBe(400);
    }
  });

  describe("the launcher", () => {
    const launcher = async (appId: string, sub: string) => {
      const path = `/registry/v1/apps/${appId}/launcher/${encodeURIComponent(sub)}`;
      const headers = signRequest({ credential: credentials.get(appId)!, method: "GET", path });
      const res = await fetch(`${base}${path}`, { headers });
      return {
        status: res.status,
        body: (await res.json()) as { apps?: { key: string; href: string; name: string }[]; error?: string },
      };
    };

    it("lists the ACTIVE apps the person holds a role in, plus public ones, with names, icons and where to open them", async () => {
      await as("dev-admin", "POST", `/admin/v1/apps/${DOCS}/activate`);
      const r = await launcher(NOTES, "dev-member");
      expect(r.status).toBe(200);
      expect(r.body.apps).toMatchObject([
        {
          key: NOTES,
          name: NOTES.toUpperCase(),
          glyph: NOTES.slice(0, 2).toUpperCase(),
          href: `http://${NOTES}.localhost:8080`,
        },
        { key: DOCS, href: `http://${DOCS}.localhost:8080` },
      ]);
    });

    it("a person with no role sees only the public app", async () => {
      expect((await launcher(NOTES, "stranger")).body.apps!.map((a) => a.key)).toEqual([DOCS]);
    });

    it("deactivating an app takes it off the launcher at once", async () => {
      await as("dev-admin", "POST", `/admin/v1/apps/${NOTES}/deactivate`);
      expect((await launcher(DOCS, "dev-member")).body.apps!.map((a) => a.key)).toEqual([DOCS]);
      await as("dev-admin", "POST", `/admin/v1/apps/${NOTES}/activate`);
      expect((await launcher(DOCS, "dev-member")).body.apps!.map((a) => a.key)).toEqual([NOTES, DOCS]);
    });

    it("an app with no launcher block (and core) never appears", async () => {
      await cli("POST", `/admin/v1/apps/${LOCAL}/activate`);
      await cli("PUT", `/admin/v1/roles/${LOCAL}.editor/grants/dev-member`);
      const keys = (await launcher(NOTES, "dev-member")).body.apps!.map((a) => a.key);
      expect(keys).not.toContain(LOCAL);
      expect(keys).not.toContain("core");
    });

    it("the request is signed and bound to the person's path: another person, another method, no signature are refused", async () => {
      const path = (s: string) => `/registry/v1/apps/${NOTES}/launcher/${s}`;
      const forB = signRequest({ credential: credentials.get(NOTES)!, method: "GET", path: path("a") });
      expect((await fetch(`${base}${path("b")}`, { headers: forB })).status).toBe(401);
      const post = signRequest({ credential: credentials.get(NOTES)!, method: "POST", path: path("a") });
      expect((await fetch(`${base}${path("a")}`, { headers: post })).status).toBe(401);
      expect((await fetch(`${base}${path("a")}`)).status).toBe(401);
      const other = signRequest({ credential: credentials.get(DOCS)!, method: "GET", path: path("a") });
      expect((await fetch(`${base}${path("a")}`, { headers: other })).status).toBe(401);
    });
  });

  it("with the CLI token switched off, only people with core.admin can call the admin API", async () => {
    const off = await startServer({ adminToken: undefined });
    try {
      expect((await call("GET", "/admin/v1/apps", `Bearer ${STATIC}`, undefined, off.base)).status).toBe(401);
      const ok = await call("GET", "/admin/v1/apps", `Bearer ${await idToken("dev-admin")}`, undefined, off.base);
      expect(ok.status).toBe(200);
    } finally {
      off.s.close();
    }
  });
});
