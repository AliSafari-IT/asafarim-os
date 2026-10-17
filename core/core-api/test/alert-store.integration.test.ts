/**
 * Admin's alert history across a core-api restart, against a real Postgres (migration 005,
 * alert-store.ts):
 *
 *  - a round's transitions are saved in order and read back newest round first, as the in-memory
 *    history shows them, with no field added or lost;
 *  - a new alerter (core-api restarted) loads the history the old one saved;
 *  - rows older than the retention window are deleted when a round is saved; newer ones stay;
 *  - the table refuses a kind or probe value that isn't one of the known ones.
 *
 * Needs CORE_API_TEST_ADMIN_URL (see registry.integration.test.ts). Skipped without it, except when
 * CORE_API_TEST_REQUIRED is set (CI), where it fails instead.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgAlertStore } from "../src/alert-store.ts";
import { createStatusAlerter, type AlertRecord } from "../src/alerts.ts";
import type { AppStatus, StatusReport } from "../src/health.ts";
import { migrate } from "../src/migrate.ts";

const ADMIN_URL = process.env.CORE_API_TEST_ADMIN_URL;
if (process.env.CORE_API_TEST_REQUIRED && !ADMIN_URL) throw new Error("CORE_API_TEST_ADMIN_URL must be set");

const coreDb = `core_alerts_${Date.now().toString(36)}`;

function entry(id: string, over: Partial<AppStatus> = {}): AppStatus {
  return {
    id,
    name: id.toUpperCase(),
    state: "active",
    polled: true,
    live: "up",
    ready: "up",
    latencyMs: 3,
    checkedAt: "2026-10-17T10:00:00.000Z",
    since: "2026-10-17T10:00:00.000Z",
    ...over,
  };
}
const down = (id: string) => entry(id, { ready: "down", error: "bad_status", detail: "503" });
const report = (...apps: AppStatus[]): StatusReport => ({
  checkedAt: "2026-10-17T10:00:00.000Z",
  intervalMs: 30_000,
  apps,
});

describe.skipIf(!ADMIN_URL)("the alert history in Postgres (integration)", () => {
  let admin: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${coreDb}"`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${coreDb}`;
    pool = new pg.Pool({ connectionString: url.href, max: 2 });
    expect(await migrate(pool)).toContain("005_alert_history.sql");
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${coreDb}"`);
      await admin.end();
    }
  });

  it("survives a restart: a new alerter loads what the old one saved, in the same order", async () => {
    await pool.query("DELETE FROM alert_events");
    let t = Date.now() - 60_000;
    const now = () => new Date((t += 1_000));
    const before = createStatusAlerter({ downRounds: 1, now, store: createPgAlertStore(pool) });
    before.observe(report(entry("core-api"), down("notes"), down("docs")));
    before.observe(report(entry("core-api"), entry("notes"), down("docs")));
    await before.settled();
    const saved = before.history().alerts;
    expect(saved.map((a) => [a.kind, a.id])).toEqual([
      ["recovered", "notes"],
      ["down", "notes"],
      ["down", "docs"],
    ]);

    const after = createStatusAlerter({ downRounds: 1, store: createPgAlertStore(pool) });
    expect(after.history().alerts).toEqual([]);
    await after.load();
    expect(after.history().alerts).toEqual(saved); // every field, error and detail included

    const small = createStatusAlerter({ downRounds: 1, historySize: 2, store: createPgAlertStore(pool) });
    await small.load();
    expect(small.history().alerts).toEqual(saved.slice(0, 2));
  });

  it("deletes rows older than the retention window when a round is saved", async () => {
    await pool.query("DELETE FROM alert_events");
    await pool.query(
      `INSERT INTO alert_events (at, kind, app_id, name, live, ready)
       VALUES (now() - interval '40 days', 'down', 'old', 'OLD', 'up', 'down'),
              (now() - interval '20 days', 'down', 'kept', 'KEPT', 'up', 'down')`,
    );
    const store = createPgAlertStore(pool, { retentionDays: 30 });
    const fresh: AlertRecord = {
      at: new Date().toISOString(),
      kind: "recovered",
      id: "kept",
      name: "KEPT",
      live: "up",
      ready: "up",
    };
    await store.save([fresh]);
    expect((await store.recent(10)).map((r) => r.id)).toEqual(["kept", "kept"]);
    expect((await store.recent(10))[0]).toEqual(fresh);
    expect(await store.recent(0)).toEqual([]);
  });

  it("refuses a kind or a probe value that isn't a known one", async () => {
    const store = createPgAlertStore(pool);
    const at = new Date().toISOString();
    await expect(
      store.save([{ at, kind: "exploded" as AlertRecord["kind"], id: "x", name: "X", live: "up", ready: "up" }]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      store.save([{ at, kind: "down", id: "x", name: "X", live: "sideways" as AlertRecord["live"], ready: "up" }]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
