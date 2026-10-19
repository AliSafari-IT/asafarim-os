/**
 * `platform app remove|purge|retention` (ADR 0001 §3 step 6): core-api's Remove, purge and retention
 * list, from the command line.
 *
 *   platform app remove <id> [--confirm <id>] [--yes]
 *                          back up the app's database and remove the app (POST /admin/v1/apps/<id>/remove)
 *   platform app purge <id> [--force] [--confirm <id>] [--yes]
 *                          drop a removed app's database and role (POST /admin/v1/apps/<id>/purge)
 *   platform app retention [--eligible] [--verify]
 *                          removed apps, their backup and purge date (GET /admin/v1/retention);
 *                          --verify: core-api checks each listed backup file against its sha256 now, and
 *                          the command exits 1 unless every listed backup is ok (with --eligible, only the
 *                          eligible entries are listed, so only those are checked)
 *
 * The confirmation rule, the same for remove and purge: the app id is always stated twice, as the
 * argument and again, either typed at the prompt or given as `--confirm <id>`. `--confirm` replaces
 * the prompt (that is how a script or a pipe runs it); without it, stdin must be a terminal. `--yes`
 * never stands in for the id: it is accepted only together with `--confirm <id>`. A mismatch, or no
 * second statement at all, stops before any request is sent.
 *
 * It talks to the admin API exactly as `platform app install` does (`adminEndpoint`: CORE_API_URL and
 * CORE_API_ADMIN_TOKEN, falling back to `.dev/core-api.env` locally).
 */
import { createInterface } from "node:readline/promises";
import { adminEndpoint } from "./app.ts";
import { clean } from "./text.ts";

type Result = { ok: boolean; lines: string[] };
type Endpoint = { baseUrl: string; token: string };

/** Where the typed confirmation comes from; tests pass a fake. */
export interface Terminal {
  /** stdin is an interactive terminal (someone can type the id). */
  isTTY: boolean;
  /** Ask, and resolve with what was typed ("" when stdin closes or on Ctrl+C). */
  ask(question: string): Promise<string>;
}

export const stdinTerminal: Terminal = {
  get isTTY() {
    return Boolean(process.stdin.isTTY);
  },
  ask: (question) =>
    new Promise((resolve) => {
      // The question goes to stderr, so stdout carries only the result.
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.once("SIGINT", () => rl.close());
      rl.once("close", () => resolve(""));
      rl.question(question).then(
        (answer) => {
          resolve(answer);
          rl.close();
        },
        () => resolve(""),
      );
    }),
};

const APP_ID = /^[a-z][a-z0-9-]{1,31}$/;

export type RetentionArgs =
  | { action: "remove"; id: string; confirm?: string; yes: boolean }
  | { action: "purge"; id: string; force: boolean; confirm?: string; yes: boolean }
  | { action: "retention"; eligible: boolean; verify: boolean };

/** `remove|purge|retention …`; null = not one of these (the usage is printed). */
export function parseRetentionArgs(args: string[]): RetentionArgs | null {
  const [action, ...rest] = args;
  if (action === "retention") {
    let eligible = false;
    let verify = false;
    for (const f of rest) {
      if (f === "--eligible" && !eligible) eligible = true;
      else if (f === "--verify" && !verify) verify = true;
      else return null;
    }
    return { action, eligible, verify };
  }
  if (action !== "remove" && action !== "purge") return null;
  const [id, ...flags] = rest;
  if (!id || !APP_ID.test(id)) return null;
  let confirm: string | undefined;
  let yes = false;
  let force = false;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (f === "--confirm" && flags[i + 1] !== undefined && confirm === undefined) confirm = flags[++i];
    else if (f === "--yes" && !yes) yes = true;
    else if (f === "--force" && action === "purge" && !force) force = true;
    else return null;
  }
  const c = confirm !== undefined ? { confirm } : {};
  return action === "remove" ? { action, id, yes, ...c } : { action, id, force, yes, ...c };
}

/**
 * The second statement of the id. Ok only when `--confirm` or the typed answer is exactly the id;
 * nothing has been sent to core-api when this refuses.
 */
export async function confirmAppId(
  id: string,
  opts: { confirm?: string; yes: boolean; verb: "remove" | "purge"; nothing: string },
  term: Terminal,
): Promise<{ ok: true } | { ok: false; lines: string[] }> {
  const refuse = (line: string) => ({ ok: false as const, lines: [line, opts.nothing] });
  if (opts.confirm !== undefined) {
    return opts.confirm === id ? { ok: true } : refuse(`--confirm "${opts.confirm}" isn't "${id}".`);
  }
  if (opts.yes) return refuse(`--yes doesn't replace the app id: pass --confirm ${id} with it.`);
  if (!term.isTTY) {
    return refuse(`stdin isn't a terminal, so the app id can't be typed: pass --confirm ${id} to ${opts.verb} it.`);
  }
  const typed = (await term.ask(`Type ${id} to ${opts.verb} it (anything else cancels): `)).trim();
  return typed === id ? { ok: true } : refuse(`Cancelled: "${typed}" isn't "${id}".`);
}

type Reply =
  | { ok: true; out: Record<string, unknown> }
  | { ok: false; status: number; error: string; message?: string; details?: unknown }
  | { ok: false; unreachable: string };

export async function request(
  { baseUrl, token }: Endpoint,
  method: "GET" | "POST",
  route: string,
  fetchImpl: typeof fetch,
  body?: object,
): Promise<Reply> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    return { ok: false, unreachable: `core-api isn't reachable at ${baseUrl} (is \`pnpm dev\` running?).` };
  }
  let out: Record<string, unknown>;
  try {
    out = (await res.json()) as Record<string, unknown>;
  } catch {
    out = {};
  }
  if (res.ok) return { ok: true, out };
  // A refusal's error and message are printed by every command, so their control characters are
  // replaced here, once (CWE-150); the codes core-api sends are plain words and stay as they are.
  return {
    ok: false,
    status: res.status,
    error: typeof out.error === "string" ? clean(out.error) : `http_${res.status}`,
    ...(typeof out.message === "string" ? { message: clean(out.message) } : {}),
    ...(out.details !== undefined ? { details: out.details } : {}),
  };
}

/** `2026-11-15T10:00:00.000Z` → `2026-11-15 10:00 UTC`; a string it can't parse is passed through, cleaned. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return clean(iso);
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(1)} ${units[u]}`;
}

const shortSha = (sha: string) => `${sha.slice(0, 12)}…`;

type Backup = { path: string; sizeBytes: number; sha256: string };

/** What every refusal shares: unreachable, the admin token, the role, the app. */
export function commonRefusal(r: Exclude<Reply, { ok: true }>, id: string, nothing: string): string[] {
  if ("unreachable" in r) return [r.unreachable, nothing];
  const why = r.message ? ` (${r.message})` : "";
  switch (r.error) {
    case "unauthorized":
      return [`core-api didn't accept the admin token (CORE_API_ADMIN_TOKEN)${why}.`, nothing];
    case "forbidden":
      return [`core-api refused: this sign-in doesn't hold core.admin${why}.`, nothing];
    case "not_found":
      return [`core-api has no app "${id}".`, nothing];
    default:
      return [`core-api refused: ${r.error}${why}`, nothing];
  }
}

function removeRefusal(r: Exclude<Reply, { ok: true }>, id: string): string[] {
  const nothing = "Nothing was removed.";
  if ("unreachable" in r) return commonRefusal(r, id, nothing);
  switch (r.error) {
    case "backup_failed":
      return [
        `core-api couldn't back up ${id}'s database${r.message ? `: ${r.message}` : ""}.`,
        `${nothing} Check CORE_API_BACKUP_DIR and pg_dump (CORE_API_PG_DUMP) on core-api's host, then retry.`,
      ];
    case "invalid_state":
      return [`${id} can't be removed${r.message ? `: ${r.message}` : ""}.`, nothing];
    case "bus_unavailable":
      return [`The event bus couldn't be cleaned up for ${id}${r.message ? ` (${r.message})` : ""}.`, nothing];
    case "registry_busy":
      return [`core-api is busy with another install or registration. ${nothing} Retry.`];
    default:
      return commonRefusal(r, id, nothing);
  }
}

/** One plain sentence per `purge_refused` reason (core-api's `details.reason`). */
function purgeRefusedLines(id: string, details: unknown, message: string | undefined): string[] {
  const d = (details ?? {}) as { reason?: unknown; purgeAfter?: unknown; backup?: { path?: unknown } };
  const file = typeof d.backup?.path === "string" ? clean(d.backup.path) : "its backup file";
  switch (d.reason) {
    case "retention":
      return [
        `${id}'s retention window isn't over: it can be purged from ${formatDate(typeof d.purgeAfter === "string" ? d.purgeAfter : null)}.`,
        "To purge it before then, add --force (the id is still confirmed).",
      ];
    case "no_backup":
      return [`${id} has no recorded backup, so its database is kept.`];
    case "backup_missing":
      return [
        `${id}'s backup ${file} isn't there any more, so its database is kept.`,
        "Put the file back at that path (or remove the app again for a new backup) before purging.",
      ];
    case "backup_mismatch":
      return [
        `${id}'s backup ${file} doesn't match its recorded sha256 (it changed after Remove), so its database is kept.`,
      ];
    default:
      return [`core-api refused the purge${message ? `: ${message}` : ""}.`];
  }
}

function purgeRefusal(r: Exclude<Reply, { ok: true }>, id: string): string[] {
  const nothing = "Nothing was dropped.";
  if ("unreachable" in r) return commonRefusal(r, id, nothing);
  switch (r.error) {
    case "purge_refused":
      return [...purgeRefusedLines(id, r.details, r.message), nothing];
    case "invalid_state":
      return [`${id} can't be purged${r.message ? `: ${r.message}` : ""}.`, nothing];
    case "bad_request":
      return [`core-api refused the purge request${r.message ? `: ${r.message}` : ""}.`, nothing];
    default:
      return commonRefusal(r, id, nothing);
  }
}

function removedLines(id: string, out: Record<string, unknown>): string[] {
  const backup = out.backup as Backup | null | undefined;
  const credentials = Number(out.revokedCredentials ?? 0);
  const grants = Array.isArray(out.removedGrants) ? out.removedGrants.length : 0;
  const waiting = Array.isArray(out.warnings) ? out.warnings.length : 0;
  const lines = [
    `${id} removed (was ${String(out.previous ?? out.from)}): ${credentials} credential(s) revoked, ${grants} grant(s) deleted.`,
  ];
  if (waiting) lines.push(`${waiting} subscription(s) of other apps now wait for a publisher of its events.`);
  if (backup) {
    lines.push(
      "",
      "Its database is backed up and kept:",
      `  backup       ${backup.path}`,
      `  size         ${formatBytes(backup.sizeBytes)}`,
      `  sha256       ${shortSha(backup.sha256)}`,
      `  purge after  ${formatDate(out.purgeAfter as string | null)}`,
      "",
      `Purge it from then with \`platform app purge ${id}\`; reinstall before that to get the data back.`,
    );
  } else {
    lines.push("It has no database: nothing was backed up and there is nothing to purge.");
  }
  return lines;
}

function purgedLines(id: string, out: Record<string, unknown>): string[] {
  const database = out.database as { name: string; result: string };
  const role = out.role as { name: string; result: string };
  const backup = out.backup as Backup;
  return [
    `${id} purged${out.forced ? " (forced: before its retention window was over)" : ""}:`,
    `  database ${database.name}: ${database.result}`,
    `  role     ${role.name}: ${role.result}`,
    "",
    `The backup ${backup.path} (sha256 ${shortSha(backup.sha256)}) is the only copy of its data now.`,
    `Restore it with \`pg_restore --create --dbname=postgres ${backup.path}\`.`,
  ];
}

interface RetentionEntry {
  appId: string;
  name: string;
  removedAt: string | null;
  database: string | null;
  backup: (Backup & { id: number; createdAt: string }) | null;
  purgeAfter: string | null;
  purgedAt: string | null;
  eligible: boolean;
  /** Only with --verify (`?verify=true`); null: no backup recorded. */
  backupCheck?: BackupVerdict | null;
}

type BackupVerdict = "ok" | "missing" | "mismatch" | "unreadable";

/** What --verify prints for each verdict; anything else core-api might answer is shown as is. */
function checkOf(e: RetentionEntry): string {
  if (e.backupCheck === undefined) return "not checked";
  if (e.backupCheck === null) return "–";
  return String(e.backupCheck);
}

/** The entries whose recorded backup isn't ok now (an entry without a backup has nothing to check). */
export function failedChecks(entries: RetentionEntry[]): RetentionEntry[] {
  return entries.filter((e) => e.backup && e.backupCheck !== "ok");
}

function statusOf(e: RetentionEntry): string {
  if (e.purgedAt) return `purged ${formatDate(e.purgedAt)}`;
  if (!e.database) return "no database";
  if (!e.backup) return "no backup (kept)";
  return e.eligible ? "eligible" : "kept";
}

/** A table in the drift report's style (padded columns, a header row), then the backup paths. */
export function formatRetention(entries: RetentionEntry[], eligibleOnly: boolean, verify = false): string[] {
  if (entries.length === 0) return [eligibleOnly ? "No removed app can be purged now." : "No removed apps."];
  const rows = entries.map((e) => [
    e.appId,
    formatDate(e.removedAt),
    e.backup ? `${formatBytes(e.backup.sizeBytes)} ${shortSha(e.backup.sha256)}` : "–",
    ...(verify ? [checkOf(e)] : []),
    formatDate(e.purgeAfter),
    statusOf(e),
  ]);
  const header = ["App", "Removed", "Backup (size, sha256)", ...(verify ? ["Check"] : []), "Purge after", "Status"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();
  const lines = [line(header), ...rows.map(line)];
  const withBackup = entries.filter((e) => e.backup);
  if (withBackup.length > 0) lines.push("", "Backups:", ...withBackup.map((e) => `  ${e.appId}  ${e.backup!.path}`));
  if (verify) lines.push("", ...verifyLines(entries));
  if (entries.some((e) => e.eligible && !e.purgedAt)) lines.push("", "Purge one with `platform app purge <id>`.");
  return lines;
}

/** The --verify verdict: one line when all is well, else one line per backup that isn't ok. */
function verifyLines(entries: RetentionEntry[]): string[] {
  const checked = entries.filter((e) => e.backup);
  if (checked.length === 0) return ["No backups to check."];
  if (checked.some((e) => e.backupCheck === undefined)) {
    return ["core-api didn't check the backups (an older core-api without ?verify=true?)."];
  }
  const failed = failedChecks(entries);
  if (failed.length === 0) return [`All ${checked.length} backup(s) match their recorded sha256.`];
  const why: Record<string, string> = {
    missing: "isn't there any more",
    mismatch: "doesn't match its recorded sha256 (it changed after Remove)",
    unreadable: "is there but couldn't be read (see core-api's log: core-api.backup_check_failed)",
  };
  return [
    `${failed.length} of ${checked.length} backup(s) failed the check:`,
    ...failed.map(
      (e) =>
        `  ${e.appId}: ${e.backup!.path} ${why[String(e.backupCheck)] ?? `(${String(e.backupCheck)})`}${
          e.purgedAt ? " — it is the only copy of its data" : ""
        }`,
    ),
  ];
}

export async function retentionCommand(
  args: string[],
  root: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  term: Terminal = stdinTerminal,
): Promise<Result | null> {
  const p = parseRetentionArgs(args);
  if (!p) return null;

  const target = adminEndpoint(root, env);
  if ("error" in target) return { ok: false, lines: [target.error] };

  if (p.action === "retention") {
    const query = [p.eligible ? "eligible=true" : "", p.verify ? "verify=true" : ""].filter(Boolean).join("&");
    const r = await request(target, "GET", `/admin/v1/retention${query ? `?${query}` : ""}`, fetchImpl);
    if (!r.ok) return { ok: false, lines: commonRefusal(r, "", "").filter(Boolean) };
    const apps = Array.isArray(r.out.apps) ? (r.out.apps as RetentionEntry[]) : [];
    const lines = formatRetention(apps, p.eligible, p.verify);
    return { ok: !p.verify || failedChecks(apps).length === 0, lines };
  }

  if (p.action === "remove") {
    const c = await confirmAppId(
      p.id,
      { confirm: p.confirm, yes: p.yes, verb: "remove", nothing: "Nothing was removed." },
      term,
    );
    if (!c.ok) return c;
    const r = await request(target, "POST", `/admin/v1/apps/${p.id}/remove`, fetchImpl);
    if (!r.ok) return { ok: false, lines: removeRefusal(r, p.id) };
    return { ok: true, lines: removedLines(p.id, r.out) };
  }

  const c = await confirmAppId(
    p.id,
    { confirm: p.confirm, yes: p.yes, verb: "purge", nothing: "Nothing was dropped." },
    term,
  );
  if (!c.ok) return c;
  const body = p.force ? { force: true, confirm: p.id } : {};
  const r = await request(target, "POST", `/admin/v1/apps/${p.id}/purge`, fetchImpl, body);
  if (!r.ok) return { ok: false, lines: purgeRefusal(r, p.id) };
  return { ok: true, lines: purgedLines(p.id, r.out) };
}
