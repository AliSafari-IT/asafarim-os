/**
 * The Remove backup (ADR 0001 §3 step 6) without a database: `createPgDumpBackups` runs a stand-in
 * pg_dump (a small Node script) so the file handling, hashing, environment and failure paths are
 * tested on their own. The real pg_dump against a real Postgres is in retention.integration.test.ts.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_RETENTION_DAYS,
  backupFileName,
  createPgDumpBackups,
  hashFile,
  parseRetentionDays,
  pgEnv,
  purgeAfter,
} from "../src/backup.ts";

const root = mkdtempSync(path.join(tmpdir(), "core-api-backup-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A stand-in pg_dump: prints its arguments and environment as JSON (the "dump"), or fails. */
function fakePgDump(name: string, body: string): string {
  const file = path.join(root, name);
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
}
const echoDump = fakePgDump(
  "pg_dump_ok",
  "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: process.env }));",
);
const failingDump = fakePgDump(
  "pg_dump_fail",
  'process.stdout.write("PGDMP partial"); process.stderr.write("pg_dump: error: connection refused\\n"); process.exit(1);',
);
const emptyDump = fakePgDump("pg_dump_empty", "");

const CONNECTION = "postgres://prov%40isioner:s3cr%3At@db.internal:6543/postgres?sslmode=require";
const files = (dir: string) => readdirSync(dir).sort();

describe("createPgDumpBackups", () => {
  it("writes the dump to a new 0600 file in a 0700 directory, with its size and sha256", async () => {
    const dir = path.join(root, "ok", "nested");
    const at = new Date("2026-10-16T12:03:04.567Z");
    process.env.CORE_API_ADMIN_TOKEN_FOR_THIS_TEST = "must-not-reach-pg_dump";
    const backups = createPgDumpBackups({ dir, connection: CONNECTION, pgDump: echoDump, now: () => at });
    const file = await backups.dump("notes", "app_notes");
    delete process.env.CORE_API_ADMIN_TOKEN_FOR_THIS_TEST;

    expect(path.dirname(file.path)).toBe(dir);
    expect(path.basename(file.path)).toMatch(/^notes-20261016T120304Z-[0-9a-f]{8}\.dump$/);
    expect(files(dir)).toEqual([path.basename(file.path)]); // no .partial left
    expect(statSync(file.path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const content = readFileSync(file.path);
    expect(file.sizeBytes).toBe(content.length);
    expect(file.sha256).toBe(createHash("sha256").update(content).digest("hex"));

    // Custom format, never a prompt; the connection only in PG* variables, never on the command line.
    const { argv, env } = JSON.parse(content.toString("utf8")) as { argv: string[]; env: Record<string, string> };
    expect(argv).toEqual(["--format=custom", "--no-password"]);
    expect(argv.join(" ")).not.toContain("s3cr");
    expect(env).toMatchObject({
      PGHOST: "db.internal",
      PGPORT: "6543",
      PGUSER: "prov@isioner",
      PGPASSWORD: "s3cr:t",
      PGDATABASE: "app_notes",
      PGSSLMODE: "require",
    });
    // Nothing else of core-api's environment.
    expect(Object.keys(env).filter((k) => k.startsWith("CORE_API"))).toEqual([]);
  });

  it("a failing pg_dump rejects with its message and leaves no file", async () => {
    const dir = path.join(root, "fail");
    const backups = createPgDumpBackups({ dir, connection: CONNECTION, pgDump: failingDump });
    await expect(backups.dump("notes", "app_notes")).rejects.toThrow(
      /exited with 1: pg_dump: error: connection refused/,
    );
    expect(files(dir)).toEqual([]);
  });

  it("no pg_dump at all, or one that writes nothing: rejected, no file", async () => {
    const dir = path.join(root, "missing");
    const none = createPgDumpBackups({ dir, connection: CONNECTION, pgDump: path.join(root, "no-such-pg_dump") });
    await expect(none.dump("notes", "app_notes")).rejects.toThrow(/ENOENT/);
    const empty = createPgDumpBackups({ dir, connection: CONNECTION, pgDump: emptyDump });
    await expect(empty.dump("notes", "app_notes")).rejects.toThrow(/wrote nothing/);
    expect(files(dir)).toEqual([]);
  });

  it("a pg_dump that runs too long is killed: rejected, no file", async () => {
    const dir = path.join(root, "slow");
    const slow = fakePgDump("pg_dump_slow", 'process.stdout.write("PGDMP"); setTimeout(() => {}, 60000);');
    const backups = createPgDumpBackups({ dir, connection: CONNECTION, pgDump: slow, timeoutMs: 200 });
    await expect(backups.dump("notes", "app_notes")).rejects.toThrow(/killed \(SIGKILL\)/);
    expect(files(dir)).toEqual([]);
  });

  it("check: ok while the file is unchanged, mismatch once it changes, missing once it's gone; discard deletes it", async () => {
    const dir = path.join(root, "check");
    const backups = createPgDumpBackups({ dir, connection: CONNECTION, pgDump: echoDump });
    const file = await backups.dump("notes", "app_notes");
    expect(await backups.check(file.path, file.sha256)).toBe("ok");
    expect(await hashFile(file.path)).toEqual({ sha256: file.sha256, sizeBytes: file.sizeBytes });
    appendFileSync(file.path, "x");
    expect(await backups.check(file.path, file.sha256)).toBe("mismatch");
    await backups.discard(file.path);
    expect(await backups.check(file.path, file.sha256)).toBe("missing");
    await backups.discard(file.path); // already gone: no error
  });
});

describe("retention settings", () => {
  it("CORE_API_RETENTION_DAYS: 0 to 3650 whole days, default 30", () => {
    expect(parseRetentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS);
    expect(parseRetentionDays("")).toBe(30);
    expect(parseRetentionDays("0")).toBe(0);
    expect(parseRetentionDays("3650")).toBe(3650);
    for (const bad of ["-1", "1.5", "3651", "thirty", "1e9"]) expect(() => parseRetentionDays(bad), bad).toThrow();
  });

  it("purge_after is removed_at plus the window", () => {
    expect(purgeAfter(new Date("2026-10-16T12:00:00Z"), 30).toISOString()).toBe("2026-11-15T12:00:00.000Z");
    expect(purgeAfter(new Date("2026-10-16T12:00:00Z"), 0).toISOString()).toBe("2026-10-16T12:00:00.000Z");
  });

  it("file names and the PG* environment", () => {
    expect(backupFileName("crm-tools", new Date("2026-01-02T03:04:05Z"))).toMatch(
      /^crm-tools-20260102T030405Z-[0-9a-f]{8}\.dump$/,
    );
    expect(pgEnv("postgres://u:p@[::1]/postgres", "app_x")).toEqual({
      PGHOST: "::1",
      PGPORT: "5432",
      PGUSER: "u",
      PGPASSWORD: "p",
      PGDATABASE: "app_x",
      PGCONNECT_TIMEOUT: "10",
    });
  });
});
