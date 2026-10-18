/**
 * `GET /admin/v1/retention?verify=true`: each recorded backup file checked against its sha256 now,
 * purged apps included. Unit tests with a fake pool and a fake check; the real pg_dump files are
 * covered by retention.integration.test.ts.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { verifyRetention } from "../src/admin.ts";
import type { BackupCheck } from "../src/backup.ts";
import type { Registry } from "../src/registry.ts";
import { createHandler } from "../src/server.ts";

const ADMIN_TOKEN = "t".repeat(40);
const SHA = (c: string) => c.repeat(64);

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `App ${id}`,
    removed_at: "2026-10-01T10:00:00.000Z",
    purge_after: "2026-10-31T10:00:00.000Z",
    purged_at: null,
    database_name: `app_${id}`,
    backup_id: 1,
    backup_path: `/backups/${id}.dump`,
    backup_size: 1234,
    backup_sha256: SHA("a"),
    backup_created_at: "2026-10-01T10:00:00.000Z",
    ...over,
  };
}

const ROWS = [
  row("kept"),
  row("gone", { backup_id: 2, backup_path: "/backups/gone.dump" }),
  row("changed", { backup_id: 3, backup_path: "/backups/changed.dump", backup_sha256: SHA("b") }),
  row("locked", { backup_id: 4, backup_path: "/backups/locked.dump" }),
  row("purged", { backup_id: 5, backup_path: "/backups/purged.dump", purged_at: "2026-11-01T00:00:00.000Z" }),
  row("old", { backup_id: null, backup_path: null, backup_size: null, backup_sha256: null, purge_after: null }),
];

function fakeCheck() {
  const calls: string[] = [];
  let running = 0;
  let overlapped = false;
  const check = async (file: string, sha256: string): Promise<BackupCheck> => {
    calls.push(file);
    running++;
    if (running > 1) overlapped = true;
    await new Promise((r) => setTimeout(r, 2));
    running--;
    if (file.endsWith("gone.dump")) return "missing";
    if (file.endsWith("locked.dump"))
      throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: "EACCES" });
    return sha256 === SHA("a") ? "ok" : "mismatch";
  };
  return { check, calls, overlapped: () => overlapped };
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function serve(opts: {
  backups?: { check: (f: string, s: string) => Promise<BackupCheck> };
  log?: (l: object) => void;
}) {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: /FROM apps a/.test(sql) && /state = 'removed'/.test(sql) ? ROWS : [] };
    },
  } as unknown as pg.Pool;
  const server = createServer(
    createHandler({
      registry: {} as Registry,
      pool,
      adminToken: ADMIN_TOKEN,
      now: () => new Date("2026-11-15T00:00:00.000Z"),
      log: opts.log ?? (() => {}),
      ...(opts.backups ? { backups: opts.backups } : {}),
    }),
  );
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (q: string) => {
    const res = await fetch(`${base}/admin/v1/retention${q}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    return {
      status: res.status,
      body: (await res.json()) as { apps?: Record<string, unknown>[]; error?: string; message?: string },
    };
  };
  return { get, queries };
}

describe("verifyRetention", () => {
  it("checks every recorded backup, purged ones included, one at a time; no backup is null", async () => {
    const f = fakeCheck();
    const logs: object[] = [];
    const entries = ROWS.map((r) => ({
      appId: r.id,
      backup: r.backup_id ? { path: r.backup_path as string, sha256: r.backup_sha256 as string } : null,
    }));
    const out = await verifyRetention(entries, f.check, (l) => logs.push(l));
    expect(out.map((e) => [e.appId, e.backupCheck])).toEqual([
      ["kept", "ok"],
      ["gone", "missing"],
      ["changed", "mismatch"],
      ["locked", "unreadable"],
      ["purged", "ok"],
      ["old", null],
    ]);
    expect(f.calls).toHaveLength(5);
    expect(f.overlapped()).toBe(false);
    // The error code only: never the message (it carries the path).
    expect(logs).toEqual([{ msg: "core-api.backup_check_failed", app: "locked", error: "EACCES" }]);
  });

  it("an error without a code is logged as 'error'", async () => {
    const logs: object[] = [];
    const out = await verifyRetention(
      [{ appId: "x", backup: { path: "/b/x.dump", sha256: SHA("a") } }],
      async () => {
        throw new Error("boom");
      },
      (l) => logs.push(l),
    );
    expect(out[0]!.backupCheck).toBe("unreadable");
    expect(logs).toEqual([{ msg: "core-api.backup_check_failed", app: "x", error: "error" }]);
  });
});

describe("GET /admin/v1/retention?verify=true", () => {
  it("adds backupCheck to each entry, and keeps everything else as without verify", async () => {
    const f = fakeCheck();
    const { get } = await serve({ backups: f });
    const plain = await get("");
    const verified = await get("?verify=true");
    expect(plain.status).toBe(200);
    expect(verified.status).toBe(200);
    expect(plain.body.apps!.every((e) => !("backupCheck" in e))).toBe(true);
    expect(verified.body.apps!.map((e) => [e.appId, e.backupCheck])).toEqual([
      ["kept", "ok"],
      ["gone", "missing"],
      ["changed", "mismatch"],
      ["locked", "unreadable"],
      ["purged", "ok"],
      ["old", null],
    ]);
    expect(verified.body.apps!.map(({ backupCheck: _, ...rest }) => rest)).toEqual(plain.body.apps);
  });

  it("without verify (or verify=false) no file is read", async () => {
    const f = fakeCheck();
    const { get } = await serve({ backups: f });
    expect((await get("")).status).toBe(200);
    expect((await get("?verify=false")).status).toBe(200);
    expect(f.calls).toEqual([]);
  });

  it("with eligible=true only the eligible entries are checked", async () => {
    const f = fakeCheck();
    const { get } = await serve({ backups: f });
    const r = await get("?eligible=true&verify=true");
    expect(r.status).toBe(200);
    // purge_after (10-31) has passed at 11-15; purged and no-backup entries aren't eligible.
    expect(r.body.apps!.map((e) => e.appId)).toEqual(["kept", "gone", "changed", "locked"]);
    expect(f.calls).toHaveLength(4);
  });

  it("refuses a verify that isn't true or false, and a verify without backups configured", async () => {
    const f = fakeCheck();
    const { get } = await serve({ backups: f });
    expect(await get("?verify=yes")).toMatchObject({ status: 400, body: { error: "bad_request" } });
    expect(await get("?eligible=maybe&verify=true")).toMatchObject({ status: 400, body: { error: "bad_request" } });
    expect(f.calls).toEqual([]);
    const without = await serve({});
    expect(await without.get("?verify=true")).toMatchObject({
      status: 400,
      body: { error: "bad_request", message: "backup verification isn't configured" },
    });
    expect((await without.get("")).status).toBe(200);
  });

  it("needs the admin token", async () => {
    const { get: _get } = await serve({ backups: fakeCheck() });
    const server = servers[servers.length - 1]!;
    const res = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/v1/retention?verify=true`,
    );
    expect(res.status).toBe(401);
  });
});
