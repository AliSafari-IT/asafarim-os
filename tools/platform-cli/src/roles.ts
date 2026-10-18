/**
 * Roles and who holds them, from the command line: the same data as Admin's Roles and People pages.
 *
 *   platform role list [--app <id>] [--json]   every declared role (or one app's) with its holders and
 *                                              permissions, and what needs migrating (GET /admin/v1/roles)
 *   platform role holders <role> [--json]      who holds one role (GET /admin/v1/roles/<role>/grants)
 *   platform role held-by <subject> [--json]   every role one person holds (GET /admin/v1/subjects/<sub>/grants)
 *
 * Read-only; `role grant|revoke` (app.ts) changes grants. It talks to the admin API as `platform status`
 * does (`adminEndpoint`: CORE_API_URL and CORE_API_ADMIN_TOKEN, falling back to `.dev/core-api.env`
 * locally). Exit code 0 when core-api answered, 1 when it can't be asked, refuses, or answers with
 * something this CLI doesn't expect. --json prints core-api's reply unchanged.
 */
import { adminEndpoint } from "./app.ts";
import { commonRefusal, formatDate, request } from "./retention.ts";
import { clean } from "./status.ts";

type Result = { ok: boolean; lines: string[]; stdout?: boolean };

/** The shapes core-api checks (server.ts, admin-auth.ts): checked here first, so a typo isn't a request. */
const APP_ID = /^(?:core|[a-z][a-z0-9-]{1,31})$/;
const ROLE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const SUBJECT = /^[A-Za-z0-9._:@-]{1,128}$/;

export type RoleReadArgs =
  | { action: "list"; app?: string; json: boolean }
  | { action: "holders"; role: string; json: boolean }
  | { action: "held-by"; subject: string; json: boolean };

/** `role list|holders|held-by …` (the words after `role`); null = not valid (the usage is printed). */
export function parseRoleReadArgs(args: string[]): RoleReadArgs | null {
  const [action, ...rest] = args;
  let json = false;
  const words: string[] = [];
  let app: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--json" && !json) json = true;
    else if (action === "list" && a === "--app" && app === undefined && rest[i + 1] !== undefined) {
      app = rest[++i]!;
      if (!APP_ID.test(app)) return null;
    } else if (!a.startsWith("--")) words.push(a);
    else return null;
  }
  if (action === "list") return words.length === 0 ? { action, json, ...(app !== undefined ? { app } : {}) } : null;
  if (words.length !== 1) return null;
  const [word] = words as [string];
  if (action === "holders") return ROLE.test(word) ? { action, role: word, json } : null;
  if (action === "held-by") return SUBJECT.test(word) ? { action, subject: word, json } : null;
  return null;
}

/** The route each read asks; the subject is percent-encoded as core-api decodes it. */
export function roleReadRoute(p: RoleReadArgs): string {
  if (p.action === "list") return p.app === undefined ? "/admin/v1/roles" : `/admin/v1/roles?app=${p.app}`;
  if (p.action === "holders") return `/admin/v1/roles/${p.role}/grants`;
  return `/admin/v1/subjects/${encodeURIComponent(p.subject)}/grants`;
}

/** One role (mirrors core-api's `AdminRole`, core/core-api/src/admin.ts); only what is shown. */
export interface ListedRole {
  key: string;
  appId: string;
  description: string | null;
  deprecated: boolean;
  permissions: { key: string; deprecated: boolean }[];
  deprecatedPermissions: string[];
  migrationNeeded: boolean;
  holders: number;
}

/** One grant: `holders` lists subjects, `held-by` lists roles. */
export interface ListedGrant {
  subject?: string;
  role?: string;
  appId?: string;
  granted_by: string;
  granted_at: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** core-api's reply as a role list, or null when it isn't one: the command then fails instead. */
export function asRoleList(out: unknown): ListedRole[] | null {
  if (!isObject(out) || !Array.isArray(out.roles)) return null;
  if (!out.roles.every((r) => isObject(r) && typeof r.key === "string")) return null;
  return out.roles as unknown as ListedRole[];
}

/** core-api's reply as a grant list keyed by `field` (subject or role), or null when it isn't one. */
export function asGrantList(out: unknown, field: "subject" | "role"): ListedGrant[] | null {
  if (!isObject(out) || !Array.isArray(out.grants)) return null;
  if (!out.grants.every((g) => isObject(g) && typeof g[field] === "string")) return null;
  return out.grants as unknown as ListedGrant[];
}

/** Padded columns, the last one not padded (`status`'s, `audit`'s and `app list`'s style). */
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
const text = (v: unknown) => (v === null || v === undefined ? "" : clean(v));

export function formatRoleList(roles: ListedRole[], app?: string): string[] {
  if (roles.length === 0) return [app === undefined ? "core-api lists no roles." : `${clean(app)} declares no roles.`];
  const rows = roles.map((r) => [
    clean(r.key),
    clean(r.appId),
    count(r.holders),
    count(Array.isArray(r.permissions) ? r.permissions.length : undefined),
    text(r.description),
  ]);
  const lines = table(["Role", "App", "Holders", "Permissions", "Description"], rows);
  const deprecated = roles
    .filter((r) => r.deprecated === true)
    .map((r) => `  ${clean(r.key)}: no longer declared by ${clean(r.appId)}; held by ${count(r.holders)}`);
  const migrate = roles
    .filter((r) => r.migrationNeeded === true)
    .map((r) => {
      const perms = Array.isArray(r.deprecatedPermissions) ? r.deprecatedPermissions.map(clean).join(", ") : "?";
      return `  ${clean(r.key)}: still grants ${perms}, which the app no longer declares`;
    });
  if (deprecated.length) lines.push("", "Deprecated roles (kept while someone holds them):", ...deprecated);
  if (migrate.length) lines.push("", "Needs migrating (ADR 0001 §3.4):", ...migrate);
  return lines;
}

export function formatHolders(role: string, grants: ListedGrant[]): string[] {
  if (grants.length === 0) return [`Nobody holds ${clean(role)}.`];
  const rows = grants.map((g) => [clean(g.subject), when(g.granted_at), clean(g.granted_by)]);
  return table(["Subject", "Granted", "Granted by"], rows);
}

export function formatHeldBy(subject: string, grants: ListedGrant[]): string[] {
  if (grants.length === 0) return [`${clean(subject)} holds no roles.`];
  const rows = grants.map((g) => [clean(g.role), clean(g.appId), when(g.granted_at), clean(g.granted_by)]);
  return table(["Role", "App", "Granted", "Granted by"], rows);
}

/** A refusal: a 404 here means core-api lacks the route (it answers an empty list for an unknown role). */
function refusal(r: Parameters<typeof commonRefusal>[0], route: string): string[] {
  if (!("unreachable" in r) && r.error === "not_found") return [`core-api has no ${route.split("?")[0]}.`];
  return commonRefusal(r, "", "").filter(Boolean);
}

export async function roleReadCommand(
  args: string[],
  root: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Result | null> {
  const p = parseRoleReadArgs(args);
  if (!p) return null;

  const target = adminEndpoint(root, env);
  if ("error" in target) return { ok: false, lines: [target.error] };

  const route = roleReadRoute(p);
  const r = await request(target, "GET", route, fetchImpl);
  if (!r.ok) return { ok: false, lines: refusal(r, route) };
  const unexpected = { ok: false, lines: [`core-api's reply to GET ${route} isn't what this CLI expects.`] };

  let lines: string[];
  if (p.action === "list") {
    const roles = asRoleList(r.out);
    if (!roles) return unexpected;
    lines = formatRoleList(roles, p.app);
  } else if (p.action === "holders") {
    const grants = asGrantList(r.out, "subject");
    if (!grants) return unexpected;
    lines = formatHolders(p.role, grants);
  } else {
    const grants = asGrantList(r.out, "role");
    if (!grants) return unexpected;
    lines = formatHeldBy(p.subject, grants);
  }
  if (p.json) return { ok: true, stdout: true, lines: [JSON.stringify(r.out, null, 2)] };
  return { ok: true, stdout: true, lines };
}
