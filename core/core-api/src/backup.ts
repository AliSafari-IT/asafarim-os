/**
 * The backup of an app's database that Remove takes (ADR 0001 §3 step 6), and the check a purge runs
 * on it before the database is dropped.
 *
 * Mechanism: `pg_dump --format=custom` (restorable with `pg_restore`), run as a child process with
 * an argument list (no shell). It connects as the provisioner role, with the connection in PG*
 * environment variables, so the password never appears in a process listing. Its output is
 * streamed to `<dir>/<app>-<UTC time>-<random>.dump.partial` (mode 0600) while its sha256 is
 * computed, and renamed to `….dump` only when pg_dump exits 0: a failed dump leaves no file.
 *
 * pg_dump has to be at least the Postgres server's major version (16 in dev). It comes from PATH, or
 * from CORE_API_PG_DUMP. core-api uses no npm package for this: a logical dump in JavaScript would
 * have to rebuild the schema itself, and pg_dump gives a consistent snapshot in a standard format.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** A finished backup file. */
export interface BackupFile {
  /** Absolute path. */
  path: string;
  sizeBytes: number;
  /** Lower-case hex. */
  sha256: string;
}

/** A purge drops the database only after `ok`. */
export type BackupCheck = "ok" | "missing" | "mismatch";

/** What the registry needs to back up an app's database and check that backup later. */
export interface DatabaseBackups {
  /** Dump the database to a new file. Throws when that fails, and then no file is left behind. */
  dump(appId: string, database: string): Promise<BackupFile>;
  /** Is the file still there, with exactly this sha256? */
  check(file: string, sha256: string): Promise<BackupCheck>;
  /** Delete a backup whose Remove was then rolled back. Never throws. */
  discard(file: string): Promise<void>;
}

/** CORE_API_RETENTION_DAYS when unset: how long a removed app's database is kept before it may be purged. */
export const DEFAULT_RETENTION_DAYS = 30;

/** CORE_API_RETENTION_DAYS: a whole number of days from 0 to 3650, default 30. */
export function parseRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 3650) {
    throw new Error("CORE_API_RETENTION_DAYS must be a whole number of days from 0 to 3650");
  }
  return n;
}

/** `removedAt` plus the retention window. */
export function purgeAfter(removedAt: Date, retentionDays: number): Date {
  return new Date(removedAt.getTime() + retentionDays * 86_400_000);
}

/** The sha256 (hex) and size of a file. Throws ENOENT when it isn't there. */
export async function hashFile(file: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    sizeBytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

/** `notes-20261016T120304Z-1a2b3c4d.dump` */
export function backupFileName(appId: string, at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return `${appId}-${stamp}-${randomBytes(4).toString("hex")}.dump`;
}

/** The PG* variables pg_dump connects with: the provisioner's URL, pointed at `database`. */
export function pgEnv(connection: string, database: string): Record<string, string> {
  const url = new URL(connection);
  const env: Record<string, string> = {
    PGHOST: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database,
    PGCONNECT_TIMEOUT: "10",
  };
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

const STDERR_KEEP = 2048;

export function createPgDumpBackups(opts: {
  /** Where backups are written (created, mode 0700, if missing). */
  dir: string;
  /** The provisioner's URL: the role pg_dump connects as. */
  connection: string;
  /** The pg_dump binary (default `pg_dump`, from PATH). */
  pgDump?: string;
  /** pg_dump is killed after this long (default 15 minutes). */
  timeoutMs?: number;
  now?: () => Date;
}): DatabaseBackups {
  const dir = path.resolve(opts.dir);
  const bin = opts.pgDump || "pg_dump";
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const now = opts.now ?? (() => new Date());

  async function dump(appId: string, database: string): Promise<BackupFile> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, backupFileName(appId, now()));
    const partial = `${file}.partial`;
    const child = spawn(bin, ["--format=custom", "--no-password"], {
      // Only what pg_dump needs: never core-api's own secrets.
      env: { PATH: process.env.PATH ?? "", ...pgEnv(opts.connection, database) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (s: string) => {
      stderr = (stderr + s).slice(-STDERR_KEEP);
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); // e.g. ENOENT: no pg_dump
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    const hash = createHash("sha256");
    let sizeBytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        done(null, chunk);
      },
    });
    try {
      const [written, result] = await Promise.allSettled([
        pipeline(child.stdout, counter, createWriteStream(partial, { flags: "wx", mode: 0o600 })).catch((err) => {
          child.kill("SIGKILL"); // nobody reads its output any more: don't let it hang until the timeout
          throw err;
        }),
        exited,
      ]);
      if (result.status === "rejected") throw result.reason;
      const { code, signal } = result.value;
      if (code !== 0) {
        const why = signal ? `was killed (${signal})` : `exited with ${code}`;
        throw new Error(`pg_dump ${why}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
      }
      if (written.status === "rejected") throw written.reason;
      if (sizeBytes === 0) throw new Error("pg_dump wrote nothing");
      await rename(partial, file);
      return { path: file, sizeBytes, sha256: hash.digest("hex") };
    } catch (err) {
      child.kill("SIGKILL");
      await rm(partial, { force: true }).catch(() => undefined);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function check(file: string, sha256: string): Promise<BackupCheck> {
    try {
      return (await hashFile(file)).sha256 === sha256 ? "ok" : "mismatch";
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return "missing";
      throw err;
    }
  }

  async function discard(file: string): Promise<void> {
    await rm(file, { force: true }).catch(() => undefined);
  }

  return { dump, check, discard };
}
