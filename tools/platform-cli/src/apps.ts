/**
 * `platform app list`: every app core-api knows, with its state, the same data as Admin's Apps page.
 *
 *   platform app list [--json]
 *                          core first, then installed apps by id, then removed ones (GET /admin/v1/apps);
 *                          --json prints core-api's reply unchanged
 *
 * Read-only. It talks to the admin API as `platform status` does (`adminEndpoint`: CORE_API_URL and
 * CORE_API_ADMIN_TOKEN, falling back to `.dev/core-api.env` locally). Exit code 0 when core-api answered,
 * 1 when it can't be asked, refuses, or answers with something that isn't an app list.
 */
import { adminEndpoint } from "./app.ts";
import { commonRefusal, formatDate, request } from "./retention.ts";
import { clean } from "./status.ts";

type Result = { ok: boolean; lines: string[]; stdout?: boolean };

export interface AppListArgs {
  json: boolean;
}

/** `app list [--json]` (the words after `list`); null = not valid (the usage is printed). */
export function parseAppListArgs(args: string[]): AppListArgs | null {
  const p: AppListArgs = { json: false };
  for (const a of args) {
    if (a === "--json" && !p.json) p.json = true;
    else return null;
  }
  return p;
}

/** One app (mirrors core-api's `AdminApp`, core/core-api/src/admin.ts); only what the table shows. */
export interface ListedApp {
  id: string;
  name: string;
  version: string;
  state: string;
  system: boolean;
  installed_at: string;
  permissions: number;
  roles: number;
  waitingForPublisher: string[];
  retention: { removedAt: string | null; purgeAfter: string | null; purgedAt: string | null } | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * core-api's reply as a list, or null when it isn't one (no `apps` array, or an entry without a string
 * id): the command then fails instead of formatting garbage.
 */
export function asAppList(out: unknown): ListedApp[] | null {
  if (!isObject(out) || !Array.isArray(out.apps)) return null;
  if (!out.apps.every((a) => isObject(a) && typeof a.id === "string")) return null;
  return out.apps as unknown as ListedApp[];
}

/** Padded columns, the last one not padded (`status`'s and `audit`'s style). */
function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? String(n) : "?");
/** A date for the terminal: formatDate passes a string it can't parse through, so it is cleaned too. */
const when = (iso: unknown) => (typeof iso === "string" ? clean(formatDate(iso)) : "–");

function stateOf(a: ListedApp): string {
  const state = clean(a.state);
  return a.system === true ? `${state} (system)` : state;
}

/** What a removed app's row adds below the table: when it was removed and when it may be purged. */
function retentionNote(a: ListedApp): string | null {
  if (a.state !== "removed") return null;
  if (!isObject(a.retention)) return `${clean(a.id)}: removed, but core-api's reply has no retention details`;
  const r = a.retention;
  const removed = `removed ${when(r.removedAt)}`;
  if (r.purgedAt) return `${clean(a.id)}: ${removed}, database purged ${when(r.purgedAt)}`;
  if (r.purgeAfter) return `${clean(a.id)}: ${removed}, purge allowed from ${when(r.purgeAfter)}`;
  return `${clean(a.id)}: ${removed}, no database kept`;
}

function waitingNote(a: ListedApp): string | null {
  if (!Array.isArray(a.waitingForPublisher) || a.waitingForPublisher.length === 0) return null;
  return `${clean(a.id)}: subscribes to ${a.waitingForPublisher.map(clean).join(", ")}, but no installed app publishes it`;
}

export function formatAppList(apps: ListedApp[]): string[] {
  if (apps.length === 0) return ["core-api lists no apps."];
  const rows = apps.map((a) => [
    clean(a.id),
    clean(a.name),
    clean(a.version),
    stateOf(a),
    when(a.installed_at),
    count(a.roles),
    count(a.permissions),
  ]);
  const lines = table(["Id", "Name", "Version", "State", "Installed", "Roles", "Permissions"], rows);
  const waiting = apps.map(waitingNote).filter((l): l is string => l !== null);
  const removed = apps.map(retentionNote).filter((l): l is string => l !== null);
  if (waiting.length)
    lines.push("", "Waiting for a publisher (a warning; nothing is blocked):", ...waiting.map((l) => `  ${l}`));
  if (removed.length) lines.push("", "Removed (see pnpm platform app retention):", ...removed.map((l) => `  ${l}`));
  return lines;
}

const APPS = "/admin/v1/apps";

/** A refusal: a 404 on this fixed route means core-api lacks it. */
function refusal(r: Parameters<typeof commonRefusal>[0]): string[] {
  if (!("unreachable" in r) && r.error === "not_found") return [`core-api has no ${APPS}.`];
  return commonRefusal(r, "", "").filter(Boolean);
}

export async function appListCommand(
  args: string[],
  root: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Result | null> {
  const p = parseAppListArgs(args);
  if (!p) return null;

  const target = adminEndpoint(root, env);
  if ("error" in target) return { ok: false, lines: [target.error] };

  const r = await request(target, "GET", APPS, fetchImpl);
  if (!r.ok) return { ok: false, lines: refusal(r) };
  const apps = asAppList(r.out);
  if (!apps) return { ok: false, lines: [`core-api's reply to GET ${APPS} isn't what this CLI expects.`] };

  if (p.json) return { ok: true, stdout: true, lines: [JSON.stringify(r.out, null, 2)] };
  return { ok: true, stdout: true, lines: formatAppList(apps) };
}

/*
 * `platform app show <id> [--json]`: one app as core-api records it (GET /admin/v1/apps/<id>): its
 * version, state, when it was installed and registered, and the permissions and roles it declares,
 * deprecated ones marked. Read-only, like `app list`; --json prints core-api's reply unchanged.
 */

/** The shape core-api's routes accept (server.ts APP_ID), plus `core`: checked first, so a typo isn't a request. */
const SHOW_APP_ID = /^(?:core|[a-z][a-z0-9-]{1,31})$/;

export interface AppShowArgs {
  id: string;
  json: boolean;
}

/** `app show <id> [--json]` (the words after `show`); null = not valid (the usage is printed). */
export function parseAppShowArgs(args: string[]): AppShowArgs | null {
  let json = false;
  const words: string[] = [];
  for (const a of args) {
    if (a === "--json" && !json) json = true;
    else if (!a.startsWith("--")) words.push(a);
    else return null;
  }
  if (words.length !== 1 || !SHOW_APP_ID.test(words[0]!)) return null;
  return { id: words[0]!, json };
}

/** One app (mirrors core-api's `registry.get`, core/core-api/src/registry.ts). */
export interface ShownApp {
  id: string;
  version: string;
  state: string;
  installed_at: string | null;
  registered_at: string | null;
  permissions: { key: string; description?: string | null; deprecated_at?: string | null }[];
  roles: { key: string; deprecated_at?: string | null }[];
}

const hasKey = (v: unknown) => isObject(v) && typeof v.key === "string";

/** core-api's reply as one app, or null when it isn't one (the command then fails instead of guessing). */
export function asShownApp(out: unknown): ShownApp | null {
  if (!isObject(out) || typeof out.id !== "string") return null;
  if (!Array.isArray(out.permissions) || !out.permissions.every(hasKey)) return null;
  if (!Array.isArray(out.roles) || !out.roles.every(hasKey)) return null;
  return out as unknown as ShownApp;
}

const deprecatedMark = (at: unknown) => (at ? `  (deprecated ${when(at)})` : "");

export function formatAppShow(app: ShownApp): string[] {
  const lines = [
    `App:         ${clean(app.id)}`,
    `Version:     ${clean(app.version)}`,
    `State:       ${clean(app.state)}`,
    `Installed:   ${when(app.installed_at)}`,
    `Registered:  ${app.registered_at ? when(app.registered_at) : "not yet"}`,
    "",
  ];
  if (app.permissions.length === 0) lines.push("Permissions: none declared");
  else {
    const width = Math.max(...app.permissions.map((p) => clean(p.key).length));
    lines.push(`Permissions (${app.permissions.length}):`);
    for (const p of app.permissions) {
      const description = typeof p.description === "string" && p.description ? clean(p.description) : "";
      lines.push(`  ${`${clean(p.key).padEnd(width)}  ${description}`.trimEnd()}${deprecatedMark(p.deprecated_at)}`);
    }
  }
  if (app.roles.length === 0) lines.push("Roles: none declared");
  else {
    lines.push(`Roles (${app.roles.length}):`);
    for (const r of app.roles) lines.push(`  ${clean(r.key)}${deprecatedMark(r.deprecated_at)}`);
  }
  const deprecated = [...app.permissions, ...app.roles].some((x) => x.deprecated_at);
  if (deprecated)
    lines.push("", "Deprecated: no longer declared by the app, kept while a role or grant still uses it.");
  if (app.state === "removed")
    lines.push("", "Removed: see pnpm platform app retention for its backup and purge date.");
  return lines;
}

export async function appShowCommand(
  args: string[],
  root: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Result | null> {
  const p = parseAppShowArgs(args);
  if (!p) return null;

  const target = adminEndpoint(root, env);
  if ("error" in target) return { ok: false, lines: [target.error] };

  const route = `${APPS}/${p.id}`;
  const r = await request(target, "GET", route, fetchImpl);
  // core-api answers not_found both for an unknown app and (with no message) for a missing route.
  if (!r.ok) return { ok: false, lines: commonRefusal(r, p.id, "").filter(Boolean) };
  const app = asShownApp(r.out);
  if (!app) return { ok: false, lines: [`core-api's reply to GET ${route} isn't what this CLI expects.`] };

  if (p.json) return { ok: true, stdout: true, lines: [JSON.stringify(r.out, null, 2)] };
  return { ok: true, stdout: true, lines: formatAppShow(app) };
}
