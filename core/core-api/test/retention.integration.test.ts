/**
 * ADR 0001 §3 step 6, the database half of Remove, over HTTP against a real Postgres and the real
 * `pg_dump`:
 *
 *  - Remove backs up the app's database (a restorable custom-format dump), records it (path, size,
 *    sha256), stops the app's role logging in, and sets purge_after = removed_at + the retention window;
 *  - a backup failure, or a bus failure after the backup, changes nothing (no file, no row, the role
 *    still logs in, the app still installed);
 *  - purge is refused before purge_after (unless forced with the typed id), without a backup, with
 *    the backup file gone or changed; then it drops the database and the role, and is audited;
 *  - a reinstall before the purge keeps the data; after it, the database is new.
 *
 * Needs CORE_API_TEST_ADMIN_URL (see registry.integration.test.ts) and a pg_dump of at least the
 * server's major version (CORE_API_TEST_PG_DUMP, default `pg_dump` from PATH). Skipped without them,
 * except when CORE_API_TEST_REQUIRED is set (CI), where it fails instead.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgDumpBackups, hashFile } from "../src/backup.ts";
import { migrate } from "../src/migrate.ts";
import { appDatabaseNames } from "../src/provision.ts";
import { createRegistry, type EventBus } from "../src/registry.ts";
import { createHandler } from "../src/server.ts";

const ADMIN_URL = process.env.CORE_API_TEST_ADMIN_URL;
const PG_DUMP = process.env.CORE_API_TEST_PG_DUMP || "pg_dump";
const HAS_PG_DUMP = spawnSync(PG_DUMP, ["--version"], { stdio: "ignore" }).status === 0;
if (process.env.CORE_API_TEST_REQUIRED && !ADMIN_URL) throw new Error("CORE_API_TEST_ADMIN_URL must be set");
if (process.env.CORE_API_TEST_REQUIRED && !HAS_PG_DUMP) {
  throw new Error(`no pg_dump (${PG_DUMP}): install the Postgres client or set CORE_API_TEST_PG_DUMP`);
}

const run = Date.now().toString(36);
const coreDb = `core_ret_${run}`;
const KEEP = `rkeep-${run}`; // removed, refused, then purged on schedule; reinstalled after the purge
const FAIL = `rfail-${run}`; // its backup fails, then the bus fails after its backup
const EARLY = `rearly-${run}`; // purged early, with force
const BACK = `rback-${run}`; // reinstalled before its purge
const OLD = `rold-${run}`; // removed "before backups existed": no backup row
const NODB = `rnodb-${run}`; // no database at all
const ALL = [KEEP, FAIL, EARLY, BACK, OLD, NODB];
const ADMIN_TOKEN = "t".repeat(40);
const DAY = 86_400_000;

function manifest(id: string, database: "postgres" | "none" = "postgres") {
  return {
    id,
    name: `Retention ${id}`,
    version: "0.1.0",
    platform: ">=0.1 <1",
    owner: "ASafariM Digital",
    runtime: {
      image: id,
      port: 3000,
      health: { live: "/healthz", ready: "/readyz" },
      resources: { memory: "128m", cpus: 0.25 },
    },
    database: database === "none" ? { engine: "none" } : { engine: "postgres", migrations: "sql" },
    auth: { client: "oidc", publicPaths: [] },
    permissions: [{ key: `${id}.read`, description: "read" }],
    roles: [{ key: `${id}.viewer`, grants: [`${id}.read`] }],
    ui: { glyph: "RT", color: "#b91c1c", nav: [], status: "active" },
  };
}

interface Backup {
  id: number;
  database: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}
interface RemoveBody {
  state: string;
  removedAt: string;
  purgeAfter: string | null;
  backup: Backup | null;
  error?: string;
}
interface Retention {
  appId: string;
  database: string | null;
  backup: Backup | null;
  purgeAfter: string | null;
  purgedAt: string | null;
  eligible: boolean;
}

describe.skipIf(!ADMIN_URL || !HAS_PG_DUMP)("remove backs up, purge after the retention window (integration)", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let backupDir: string;
  const servers: Server[] = [];
  const dbUrls = new Map<string, string>();
  let base: string;
  // The clock Remove stamps removed_at with and purge compares purge_after against.
  let clock = new Date();
  const now = () => clock;

  async function coreApi(over: { pgDump?: string; bus?: EventBus } = {}) {
    const registry = createRegistry({
      pool,
      now,
      bus: over.bus,
      provisioner: async () => {
        const c = new pg.Client({ connectionString: ADMIN_URL });
        await c.connect();
        return c;
      },
      appDatabaseHost: { host: new URL(ADMIN_URL!).hostname, port: Number(new URL(ADMIN_URL!).port || 5432) },
      backups: createPgDumpBackups({ dir: backupDir, connection: ADMIN_URL!, pgDump: over.pgDump ?? PG_DUMP }),
      retentionDays: 30,
    });
    const server = createServer(createHandler({ registry, pool, adminToken: ADMIN_TOKEN, now, log: () => {} }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const cli = (method: string, p: string, body?: unknown, at = base) =>
    fetch(`${at}${p}`, {
      method,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as T;
  const install = async (id: string, database: "postgres" | "none" = "postgres") => {
    const res = await cli("POST", `/admin/v1/apps/${id}/install`, manifest(id, database));
    expect(res.status).toBe(201);
    const out = await json<{ database: { url: string } | null }>(res);
    if (out.database) dbUrls.set(id, out.database.url);
    return out;
  };
  const remove = (id: string, at = base) => cli("POST", `/admin/v1/apps/${id}/remove`, undefined, at);
  const purge = (id: string, body?: unknown) => cli("POST", `/admin/v1/apps/${id}/purge`, body);
  /** Run SQL as the app, with the URL install gave it. */
  async function asApp(id: string, sql: string) {
    const c = new pg.Client({ connectionString: dbUrls.get(id) });
    await c.connect();
    try {
      return (await c.query(sql)).rows;
    } finally {
      await c.end();
    }
  }
  const canLogIn = (id: string) =>
    asApp(id, "SELECT 1").then(
      () => true,
      (err: Error) => {
        expect(err.message).toMatch(/not permitted to log in/);
        return false;
      },
    );
  const databaseExists = async (id: string) =>
    ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [appDatabaseNames(id).database])).rowCount ??
      0) > 0;
  const roleExists = async (id: string) =>
    ((await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [appDatabaseNames(id).role])).rowCount ?? 0) > 0;
  const filesOf = (id: string) => readdirSync(backupDir).filter((f) => f.startsWith(`${id}-`));
  const auditOf = async (id: string, action: string) =>
    (
      await pool.query("SELECT actor, detail FROM audit_events WHERE app_id = $1 AND action = $2 ORDER BY id", [
        id,
        action,
      ])
    ).rows;
  const retention = async (q = "") =>
    (await json<{ apps: Retention[] }>(await cli("GET", `/admin/v1/retention${q}`))).apps;
  const refusal = async (res: Response) => {
    const body = await json<{ error: string; details?: { reason?: string } }>(res);
    return [res.status, body.error, body.details?.reason];
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${coreDb}"`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${coreDb}`;
    pool = new pg.Pool({ connectionString: url.href, max: 4 });
    await migrate(pool);
    backupDir = mkdtempSync(path.join(tmpdir(), "core-api-retention-"));
    base = await coreApi();
  });

  afterAll(async () => {
    for (const s of servers) s.close();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${coreDb}"`);
      for (const id of ALL) {
        const { database, role } = appDatabaseNames(id);
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      }
      await admin.end();
    }
    if (backupDir) rmSync(backupDir, { recursive: true, force: true });
  });

  it("remove: pg_dump backup recorded (path, size, sha256), the role locked out, purge_after = removed_at + 30 days", async () => {
    await install(KEEP);
    await asApp(KEEP, "CREATE TABLE notes (id int PRIMARY KEY, body text); INSERT INTO notes VALUES (1, 'kept')");
    clock = new Date("2026-10-16T12:00:00.000Z");

    const res = await remove(KEEP);
    expect(res.status).toBe(200);
    const out = await json<RemoveBody>(res);
    expect(out).toMatchObject({
      state: "removed",
      removedAt: "2026-10-16T12:00:00.000Z",
      purgeAfter: "2026-11-15T12:00:00.000Z",
      backup: { database: appDatabaseNames(KEEP).database, createdAt: "2026-10-16T12:00:00.000Z" },
    });
    const backup = out.backup!;
    expect(path.dirname(backup.path)).toBe(backupDir);
    expect(filesOf(KEEP)).toEqual([path.basename(backup.path)]);
    expect(await hashFile(backup.path)).toEqual({ sha256: backup.sha256, sizeBytes: backup.sizeBytes });
    // A custom-format pg_dump archive.
    expect(readFileSync(backup.path).subarray(0, 5).toString("latin1")).toBe("PGDMP");

    const row = (await pool.query("SELECT * FROM app_backups WHERE app_id = $1", [KEEP])).rows;
    expect(row).toEqual([
      expect.objectContaining({
        id: String(backup.id),
        database_name: appDatabaseNames(KEEP).database,
        path: backup.path,
        size_bytes: String(backup.sizeBytes),
        sha256: backup.sha256,
      }),
    ]);
    const app = (await pool.query("SELECT removed_at, purge_after, backup_id FROM apps WHERE id = $1", [KEEP])).rows[0];
    expect(app.removed_at.toISOString()).toBe("2026-10-16T12:00:00.000Z");
    expect(app.purge_after.toISOString()).toBe("2026-11-15T12:00:00.000Z");
    expect(app.backup_id).toBe(String(backup.id));
    expect(await auditOf(KEEP, "app.removed")).toEqual([
      expect.objectContaining({
        actor: "admin",
        detail: expect.objectContaining({ backup: expect.objectContaining({ sha256: backup.sha256 }) }),
      }),
    ]);

    // The database is kept, but the app can't log in to it any more: the backup is its final state.
    expect(await databaseExists(KEEP)).toBe(true);
    expect(await canLogIn(KEEP)).toBe(false);
  });

  it("the Apps list and the retention list show the backup and the purge date", async () => {
    const apps = (
      await json<{ apps: { id: string; retention: Retention | null }[] }>(await cli("GET", "/admin/v1/apps"))
    ).apps;
    expect(apps.find((a) => a.id === KEEP)?.retention).toMatchObject({
      database: appDatabaseNames(KEEP).database,
      purgeAfter: "2026-11-15T12:00:00.000Z",
      purgedAt: null,
      eligible: false,
      backup: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(apps.find((a) => a.id === "core")?.retention).toBeNull();
    expect((await retention()).map((r) => r.appId)).toContain(KEEP);
    expect((await retention("?eligible=true")).map((r) => r.appId)).not.toContain(KEEP);
    expect((await cli("GET", "/admin/v1/retention?eligible=maybe")).status).toBe(400);
  });

  it("a backup failure: 503 backup_failed, and nothing changes (no file, no row, the role logs in, still installed)", async () => {
    await install(FAIL);
    await asApp(FAIL, "CREATE TABLE t (x int)");
    const broken = await coreApi({ pgDump: path.join(backupDir, "no-such-pg_dump") });
    const res = await remove(FAIL, broken);
    expect(await refusal(res)).toEqual([503, "backup_failed", undefined]);

    expect((await pool.query("SELECT state, removed_at, backup_id FROM apps WHERE id = $1", [FAIL])).rows[0]).toEqual({
      state: "installed",
      removed_at: null,
      backup_id: null,
    });
    expect(
      (await pool.query("SELECT 1 FROM app_credentials WHERE app_id = $1 AND revoked_at IS NULL", [FAIL])).rowCount,
    ).toBe(1);
    expect((await pool.query("SELECT 1 FROM app_backups WHERE app_id = $1", [FAIL])).rowCount).toBe(0);
    expect(await auditOf(FAIL, "app.removed")).toEqual([]);
    expect(filesOf(FAIL)).toEqual([]);
    expect(await canLogIn(FAIL)).toBe(true);
  });

  it("a bus failure AFTER the backup: the backup file is deleted and the role logs in again", async () => {
    const failing: EventBus = {
      ensureAppStream: async () => ({ stream: "x", result: "exists" }),
      ensureConsumer: async () => ({ consumer: "x", result: "exists" }),
      deleteConsumer: async () => ({ consumer: "x", result: "absent" }),
      deleteAppStream: async () => {
        throw new Error("connection refused");
      },
    };
    const down = await coreApi({ bus: failing });
    const res = await remove(FAIL, down);
    expect(await refusal(res)).toEqual([503, "bus_unavailable", undefined]);
    expect((await pool.query("SELECT state FROM apps WHERE id = $1", [FAIL])).rows[0].state).toBe("installed");
    expect((await pool.query("SELECT 1 FROM app_backups WHERE app_id = $1", [FAIL])).rowCount).toBe(0);
    expect(filesOf(FAIL)).toEqual([]);
    expect(await canLogIn(FAIL)).toBe(true);
  });

  it("purge is refused before purge_after, and a forced one needs the app id typed; nothing is dropped", async () => {
    clock = new Date("2026-11-15T11:59:59.000Z"); // one second early
    expect(await refusal(await purge(KEEP))).toEqual([409, "purge_refused", "retention"]);
    expect(await refusal(await purge(KEEP, { force: true }))).toEqual([400, "bad_request", undefined]);
    expect(await refusal(await purge(KEEP, { force: true, confirm: "nope" }))).toEqual([400, "bad_request", undefined]);
    expect(await refusal(await purge(KEEP, { force: "yes", confirm: KEEP }))).toEqual([400, "bad_request", undefined]);
    expect(await databaseExists(KEEP)).toBe(true);
    expect(await auditOf(KEEP, "app.purged")).toEqual([]);
  });

  it("purge is refused when the backup file is gone or changed, and for an app without a recorded backup", async () => {
    clock = new Date("2026-11-15T12:00:00.000Z"); // due
    const [{ path: file }] = (await pool.query("SELECT path FROM app_backups WHERE app_id = $1", [KEEP])).rows;
    renameSync(file, `${file}.away`);
    expect(await refusal(await purge(KEEP))).toEqual([409, "purge_refused", "backup_missing"]);
    renameSync(`${file}.away`, file);
    const original = readFileSync(file);
    appendFileSync(file, "tampered");
    expect(await refusal(await purge(KEEP))).toEqual([409, "purge_refused", "backup_mismatch"]);
    rmSync(file);
    appendFileSync(file, original);

    // An app removed before backups existed (#69): the database stays, nothing to check it against.
    await install(OLD);
    expect((await remove(OLD)).status).toBe(200);
    await pool.query("UPDATE apps SET backup_id = NULL, purge_after = NULL WHERE id = $1", [OLD]);
    expect(await refusal(await purge(OLD, { force: true, confirm: OLD }))).toEqual([409, "purge_refused", "no_backup"]);
    expect(await databaseExists(OLD)).toBe(true);

    // Not removed, no database, unknown, built in: not a purge.
    await install(NODB, "none");
    expect(await refusal(await purge(NODB))).toEqual([409, "invalid_state", undefined]);
    const removedNoDb = await json<RemoveBody>(await remove(NODB));
    expect(removedNoDb).toMatchObject({ backup: null, purgeAfter: null });
    expect(await refusal(await purge(NODB))).toEqual([409, "invalid_state", undefined]);
    expect(await refusal(await purge(`nope-${run}`))).toEqual([404, "not_found", undefined]);
    expect(await refusal(await purge("core"))).toEqual([409, "invalid_state", undefined]); // built in
    expect(await databaseExists(KEEP)).toBe(true);
  });

  it("purge after the window: the database and the role are dropped, audited; the backup stays; once only", async () => {
    expect((await retention("?eligible=true")).map((r) => r.appId)).toContain(KEEP);
    const res = await purge(KEEP);
    expect(res.status).toBe(200);
    const out = await json(res);
    expect(out).toMatchObject({
      appId: KEEP,
      database: { name: appDatabaseNames(KEEP).database, result: "dropped" },
      role: { name: appDatabaseNames(KEEP).role, result: "dropped" },
      purgedAt: "2026-11-15T12:00:00.000Z",
      forced: false,
    });
    expect(await databaseExists(KEEP)).toBe(false);
    expect(await roleExists(KEEP)).toBe(false);
    const [entry] = await auditOf(KEEP, "app.purged");
    expect(entry).toMatchObject({ actor: "admin", detail: { forced: false, database: { result: "dropped" } } });
    expect(existsSync((out.backup as Backup).path)).toBe(true);
    expect((await retention()).find((r) => r.appId === KEEP)).toMatchObject({
      purgedAt: "2026-11-15T12:00:00.000Z",
      eligible: false,
    });
    expect(await refusal(await purge(KEEP))).toEqual([409, "invalid_state", undefined]);
  });

  it("a forced purge before the window, with the app id typed: dropped, audited as forced", async () => {
    await install(EARLY);
    clock = new Date("2026-12-01T00:00:00.000Z");
    expect((await remove(EARLY)).status).toBe(200);
    const res = await purge(EARLY, { force: true, confirm: EARLY });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ forced: true, database: { result: "dropped" } });
    expect(await databaseExists(EARLY)).toBe(false);
    expect(await auditOf(EARLY, "app.purged")).toEqual([
      expect.objectContaining({ detail: expect.objectContaining({ forced: true }) }),
    ]);
  });

  it("reinstall before the purge keeps the data and stops the retention clock; after the purge, the database is new", async () => {
    await install(BACK);
    await asApp(BACK, "CREATE TABLE notes (id int); INSERT INTO notes VALUES (42)");
    expect((await remove(BACK)).status).toBe(200);
    expect(await canLogIn(BACK)).toBe(false);

    await install(BACK); // a new password, and the role may log in again
    expect(await asApp(BACK, "SELECT id FROM notes")).toEqual([{ id: 42 }]);
    expect(
      (await pool.query("SELECT removed_at, purge_after, purged_at, backup_id FROM apps WHERE id = $1", [BACK]))
        .rows[0],
    ).toEqual({ removed_at: null, purge_after: null, purged_at: null, backup_id: null });
    expect((await auditOf(BACK, "app.installed")).at(-1)).toMatchObject({ detail: { db: "exists" } });
    expect((await pool.query("SELECT 1 FROM app_backups WHERE app_id = $1", [BACK])).rowCount).toBe(1); // history
    expect(await refusal(await purge(BACK))).toEqual([409, "invalid_state", undefined]);

    // KEEP was purged: installing it again gives it a new, empty database.
    await install(KEEP);
    expect((await auditOf(KEEP, "app.installed")).at(-1)).toMatchObject({ detail: { db: "created" } });
    expect(await asApp(KEEP, "SELECT to_regclass('public.notes') AS t")).toEqual([{ t: null }]);
  });
});
