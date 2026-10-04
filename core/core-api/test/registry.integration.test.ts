/**
 * core-api end to end over HTTP against a real Postgres (the OS-D1 dev server):
 * install → register → upgrade → deactivate, and every safety-rule refusal.
 *
 * Needs CORE_API_TEST_ADMIN_URL: a superuser URL on a DEV Postgres (e.g.
 * postgres://postgres:postgres-dev-only@127.0.0.1:55440/postgres from
 * `pnpm dev`). It creates a throwaway core database and uniquely named app
 * databases and drops them all afterwards. Skipped without it, except when
 * CORE_API_TEST_REQUIRED is set (CI), where it fails instead.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signRegistration } from "../src/credentials.ts";
import { migrate } from "../src/migrate.ts";
import { appDatabaseNames } from "../src/provision.ts";
import { createRegistry } from "../src/registry.ts";
import { createHandler } from "../src/server.ts";

const ADMIN_URL = process.env.CORE_API_TEST_ADMIN_URL;
if (process.env.CORE_API_TEST_REQUIRED && !ADMIN_URL) throw new Error("CORE_API_TEST_ADMIN_URL must be set");

const run = Date.now().toString(36);
const coreDb = `core_test_${run}`;
const APP = `notes-${run}`; // unique per run: app databases are cluster-wide
const OTHER = `crm-${run}`;
const ADMIN_TOKEN = "t".repeat(40);

/** The JSON responses the tests read. */
interface RegisterResponse {
  error?: string;
  appId?: string;
  version?: string;
  state?: string;
  permissions: { added: string[]; restored: string[]; deprecated: string[] };
}
interface InstallResponse {
  appId: string;
  state: string;
  credential: string;
  database: { name: string; role: string; url: string };
}

function manifest(
  id: string,
  over: { version?: string; permissions?: string[]; roles?: { key: string; grants: string[] }[]; extra?: object } = {},
) {
  const permissions = over.permissions ?? [`${id}.notes.read`, `${id}.notes.write`];
  return {
    id,
    name: "Notes",
    version: over.version ?? "0.1.0",
    platform: ">=0.1 <1",
    owner: "ASafariM Digital",
    runtime: {
      image: id,
      port: 3000,
      health: { live: "/healthz", ready: "/readyz" },
      resources: { memory: "128m", cpus: 0.25 },
    },
    database: { engine: "postgres", migrations: "sql" },
    auth: { client: "oidc", publicPaths: [] },
    permissions: permissions.map((key) => ({ key, description: `can ${key}` })),
    roles: over.roles ?? [{ key: `${id}.editor`, grants: [`${id}.*`] }],
    events: { subscribes: [{ type: "identity.user.updated.v1", handler: "/events/user-updated" }] },
    ui: { glyph: "NT", color: "#7c3aed", nav: [], status: "active" },
    ...over.extra,
  };
}

describe.skipIf(!ADMIN_URL)("core-api registry (integration)", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  const credentials = new Map<string, string>();

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${coreDb}"`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${coreDb}`;
    pool = new pg.Pool({ connectionString: url.href, max: 4 });
    await migrate(pool);
    const registry = createRegistry({
      pool,
      provisioner: async () => {
        const c = new pg.Client({ connectionString: ADMIN_URL });
        await c.connect();
        return c;
      },
      appDatabaseHost: { host: url.hostname, port: Number(url.port) },
    });
    server = createServer(createHandler({ registry, pool, adminToken: ADMIN_TOKEN, log: () => {} }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

  const adminPost = (path: string, body?: unknown, token = ADMIN_TOKEN) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function register(
    id: string,
    m: unknown,
    opts: { credential?: string; now?: Date; headers?: Record<string, string>; body?: string } = {},
  ) {
    const body = opts.body ?? JSON.stringify(m);
    const headers =
      opts.headers ??
      signRegistration({ appId: id, credential: opts.credential ?? credentials.get(id)!, body, now: opts.now });
    const res = await fetch(`${base}/registry/v1/apps/${id}`, { method: "POST", headers, body });
    return { status: res.status, body: (await res.json()) as RegisterResponse };
  }

  const count = async (sql: string, params: unknown[] = []) => Number((await pool.query(sql, params)).rows[0].n);

  it("install: validates, creates the app's database and role (locked down), returns the credential once", async () => {
    const res = await adminPost(`/admin/v1/apps/${APP}/install`, manifest(APP));
    expect(res.status).toBe(201);
    const out = (await res.json()) as InstallResponse;
    expect(out).toMatchObject({ appId: APP, state: "installed", database: { name: appDatabaseNames(APP).database } });
    expect(out.credential).toMatch(/^osk1\./);
    credentials.set(APP, out.credential);

    const db = (
      await admin.query(
        "SELECT has_database_privilege('public', $1, 'CONNECT') AS pub, has_database_privilege($2, $1, 'CONNECT') AS own",
        [out.database.name, out.database.role],
      )
    ).rows[0];
    expect(db).toEqual({ pub: false, own: true });
    // The app can reach its database with the URL it was given.
    const appClient = new pg.Client({ connectionString: out.database.url });
    await appClient.connect();
    expect((await appClient.query("SELECT current_database() AS d")).rows[0].d).toBe(out.database.name);
    await appClient.end();
    // Only the verifier is stored, never the credential itself.
    const stored = (await pool.query("SELECT verifier FROM app_credentials WHERE app_id = $1", [APP])).rows[0]
      .verifier as string;
    expect(out.credential).not.toContain(stored);

    const again = await adminPost(`/admin/v1/apps/${APP}/install`, manifest(APP));
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("already_installed");
  });

  it("register: upserts the catalog, never grants anything and never changes the state", async () => {
    const r = await register(APP, manifest(APP));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ appId: APP, version: "0.1.0", state: "installed" });
    expect(r.body.permissions.added.sort()).toEqual([`${APP}.notes.read`, `${APP}.notes.write`]);
    expect(await count("SELECT count(*) AS n FROM role_permissions WHERE role_key = $1", [`${APP}.editor`])).toBe(2);
    expect(await count("SELECT count(*) AS n FROM event_subscriptions WHERE app_id = $1", [APP])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM role_grants")).toBe(0);
    expect((await pool.query("SELECT state FROM apps WHERE id = $1", [APP])).rows[0].state).toBe("installed");
  });

  it("upgrade: a new permission is added, a removed one deprecated (not deleted), a re-declared one restored", async () => {
    const v2 = manifest(APP, { version: "0.2.0", permissions: [`${APP}.notes.read`, `${APP}.notes.share`] });
    let r = await register(APP, v2);
    expect(r.status).toBe(200);
    expect(r.body.permissions).toEqual({
      added: [`${APP}.notes.share`],
      restored: [],
      deprecated: [`${APP}.notes.write`],
    });
    const write = (await pool.query("SELECT deprecated_at FROM permissions WHERE key = $1", [`${APP}.notes.write`]))
      .rows[0];
    expect(write.deprecated_at).toBeInstanceOf(Date); // still there, deprecated

    r = await register(
      APP,
      manifest(APP, {
        version: "0.3.0",
        permissions: [`${APP}.notes.read`, `${APP}.notes.share`, `${APP}.notes.write`],
      }),
    );
    expect(r.body.permissions).toEqual({ added: [], restored: [`${APP}.notes.write`], deprecated: [] });
    expect((await pool.query("SELECT version FROM apps WHERE id = $1", [APP])).rows[0].version).toBe("0.3.0");
  });

  it("lifecycle: activate → deactivate, refused transitions, every step audited", async () => {
    expect((await adminPost(`/admin/v1/apps/${APP}/deactivate`)).status).toBe(409); // installed → can't deactivate
    let res = await adminPost(`/admin/v1/apps/${APP}/activate`);
    expect(await res.json()).toMatchObject({ state: "active", previous: "installed" });
    res = await adminPost(`/admin/v1/apps/${APP}/deactivate`);
    expect(await res.json()).toMatchObject({ state: "inactive", previous: "active" });
    // An inactive app can still register (its data and catalog are kept); it stays inactive.
    const r = await register(
      APP,
      manifest(APP, {
        version: "0.3.1",
        permissions: [`${APP}.notes.read`, `${APP}.notes.share`, `${APP}.notes.write`],
      }),
    );
    expect(r.body.state).toBe("inactive");
    const actions = (await pool.query("SELECT action FROM audit_events WHERE app_id = $1 ORDER BY id", [APP])).rows.map(
      (x) => x.action,
    );
    expect(actions).toEqual([
      "app.installed",
      "app.registered",
      "app.registered",
      "app.registered",
      "app.activated",
      "app.deactivated",
      "app.registered",
    ]);
  });

  describe("safety rules", () => {
    it("an unknown app (no install record) can't register", async () => {
      const someone = credentials.get(APP)!; // a valid credential, but for another app
      const r = await register(OTHER, manifest(OTHER), { credential: someone, headers: undefined });
      expect(r).toMatchObject({ status: 403, body: { error: "unknown_app" } });
    });

    it("a manifest outside the app's own namespace is refused", async () => {
      const bad = manifest(APP, { permissions: [`${APP}.notes.read`, "billing.invoices.read"], roles: [] });
      const r = await register(APP, bad);
      expect(r).toMatchObject({ status: 422, body: { error: "namespace_violation" } });
      const evt = manifest(APP, {
        extra: { events: { publishes: [{ type: "billing.invoice.paid.v1", schema: "./x.json" }] } },
      });
      expect((await register(APP, evt)).body.error).toBe("namespace_violation");
      expect(await count("SELECT count(*) AS n FROM permissions WHERE key = 'billing.invoices.read'")).toBe(0);
    });

    it("registration can't grant: a role granting another app's permission or '*' is refused, role_grants stays empty", async () => {
      for (const grants of [["*"], ["billing.invoices.read"], [`${APP}.notes.read`, "hub.*"]]) {
        const r = await register(APP, manifest(APP, { roles: [{ key: `${APP}.sneaky`, grants }] }));
        expect(r.status).toBe(422);
        expect(["namespace_violation", "invalid_manifest"]).toContain(r.body.error);
      }
      expect(await count("SELECT count(*) AS n FROM roles WHERE key = $1", [`${APP}.sneaky`])).toBe(0);
      expect(await count("SELECT count(*) AS n FROM role_grants")).toBe(0);
    });

    it("manifest.id must match the URL (a validly signed body for another id)", async () => {
      const body = JSON.stringify(manifest(`x${run}`));
      const signed = signRegistration({ appId: APP, credential: credentials.get(APP)!, body });
      const res = await fetch(`${base}/registry/v1/apps/${APP}`, { method: "POST", headers: signed, body });
      expect(((await res.json()) as { error: string }).error).toBe("app_id_mismatch");
    });

    it("a bad signature is refused: a tampered body, another app's key, garbage", async () => {
      const body = JSON.stringify(manifest(APP));
      const headers = signRegistration({ appId: APP, credential: credentials.get(APP)!, body });
      expect((await register(APP, null, { headers, body: body.replace("0.1.0", "9.9.9") })).body.error).toBe(
        "bad_signature",
      );
      // Install a second app, then use ITS key for APP.
      const other = (await (await adminPost(`/admin/v1/apps/${OTHER}/install`, manifest(OTHER))).json()) as {
        credential: string;
      };
      const forged = signRegistration({ appId: APP, credential: other.credential, body });
      expect((await register(APP, null, { headers: forged, body })).body.error).toBe("bad_signature");
      expect(
        (await register(APP, null, { headers: { ...headers, "x-asafarim-signature": "v1=AAAA" }, body })).body.error,
      ).toBe("bad_signature");
    });

    it("an expired (±60 s) or replayed signature is refused, and missing headers too", async () => {
      const old = await register(
        APP,
        manifest(APP, {
          version: "0.3.1",
          permissions: [`${APP}.notes.read`, `${APP}.notes.share`, `${APP}.notes.write`],
        }),
        { now: new Date(Date.now() - 120_000) },
      );
      expect(old).toMatchObject({ status: 401, body: { error: "expired_signature" } });
      const future = await register(APP, manifest(APP), { now: new Date(Date.now() + 120_000) });
      expect(future.body.error).toBe("expired_signature");

      const body = JSON.stringify(
        manifest(APP, {
          version: "0.3.2",
          permissions: [`${APP}.notes.read`, `${APP}.notes.share`, `${APP}.notes.write`],
        }),
      );
      const headers = signRegistration({ appId: APP, credential: credentials.get(APP)!, body });
      expect((await register(APP, null, { headers, body })).status).toBe(200);
      expect((await register(APP, null, { headers, body })).body.error).toBe("replayed_signature");

      expect((await register(APP, null, { headers: { "content-type": "application/json" }, body })).body.error).toBe(
        "missing_signature",
      );
    });

    it("admin endpoints need the admin token", async () => {
      const res = await adminPost(`/admin/v1/apps/${APP}/activate`, undefined, "wrong");
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe("unauthorized");
    });
  });
});
