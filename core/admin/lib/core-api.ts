/**
 * The console's one connection to core-api: the admin API, called on behalf of the signed-in
 * administrator with THEIR identity ID token (core-api verifies it and checks `core.admin`
 * itself, per request, and audits the action as `user:<sub>`). The console holds no admin
 * secret of its own.
 */

import { parseLauncher, type LauncherTile } from "@asafarim/app-sdk";

export class CoreApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CoreApiError";
    this.status = status;
    this.code = code;
  }
}

export interface AdminApp {
  id: string;
  name: string;
  version: string;
  state: "installed" | "active" | "inactive" | "removed";
  system: boolean;
  installed_at: string;
  registered_at: string | null;
  permissions: number;
  roles: number;
  /** Event types it subscribes to whose publisher isn't installed: shown as a warning (P4.1). */
  waitingForPublisher?: string[];
  /** A removed app's backup and purge date (mirrors core-api's `Retention`, src/admin.ts); null otherwise. */
  retention?: Retention | null;
}

/** What Remove kept of a removed app's database, and when it may be purged (ADR 0001 §3 step 6). */
export interface Retention {
  removedAt: string | null;
  /** null: the app had no database, so there is nothing to back up or purge. */
  database: string | null;
  backup: { id: number; path: string; sizeBytes: number; sha256: string; createdAt: string } | null;
  /** From when a purge is allowed without forcing it. */
  purgeAfter: string | null;
  purgedAt: string | null;
  /** A purge would be accepted now (core-api still checks the backup file first). */
  eligible: boolean;
}

export interface AdminRole {
  key: string;
  appId: string;
  description: string | null;
  deprecated: boolean;
  permissions: { key: string; deprecated: boolean }[];
  deprecatedPermissions: string[];
  migrationNeeded: boolean;
  holders: number;
}

export interface AuditEvent {
  id: number;
  at: string;
  actor: string;
  action: string;
  appId: string | null;
  detail: Record<string, unknown>;
}

/** A subscriber in the event catalog (mirrors core-api's `CatalogSubscriber`, src/admin.ts). */
export interface CatalogSubscriber {
  appId: string;
  state: string;
  handler: string;
  /** `waiting_for_publisher`: no installed app publishes the type yet (the Apps page's warning). */
  consumer: "bound" | "waiting_for_publisher";
}

/** One event type in the catalog (P4.2; mirrors core-api's `CatalogEntry`, src/admin.ts). */
export interface CatalogEntry {
  type: string;
  /** null: a dangling subscription, nobody installed publishes this type. */
  publisher: { appId: string; version: string; state: string } | null;
  schema: object | null;
  schemaStatus: "provided" | "not_provided" | "no_publisher";
  schemaUpdatedAt: string | null;
  /** The publisher's version when it uploaded the schema. */
  schemaAppVersion: string | null;
  subscribers: CatalogSubscriber[];
}

/** What core-api did when it removed an app (the parts the console shows). */
export interface RemoveResult {
  appId: string;
  state: "removed";
  previous: string;
  revokedCredentials: number;
  removedGrants: { role: string; subject: string }[];
  /** Other apps' subscriptions that now wait for a publisher. */
  warnings: { app: string; type: string; code: string }[];
  /** The backup of its database (null: it has none), and from when it may be purged. */
  backup: { path: string; sizeBytes: number; sha256: string } | null;
  purgeAfter: string | null;
}

/** What core-api did when it purged a removed app's database (the parts the console shows). */
export interface PurgeResult {
  appId: string;
  database: { name: string; result: "dropped" | "absent" };
  role: { name: string; result: "dropped" | "absent" };
  backup: { path: string; sha256: string };
  /** Purged before its retention window was over. */
  forced: boolean;
}

/** One row of the status board (P6.1; mirrors core-api's `AppStatus`, src/health.ts). */
export interface AppStatus {
  id: string;
  name: string;
  state: string;
  /** False for an app that isn't active: live/ready are `unknown`. */
  polled: boolean;
  live: "up" | "down" | "unknown";
  ready: "up" | "down" | "unknown";
  latencyMs: number | null;
  error?: string;
  /** The HTTP status behind `bad_status`, the env var behind `no_upstream`, or core-api's failed checks. */
  detail?: string;
  checkedAt: string | null;
  since: string;
}

export interface StatusReport {
  checkedAt: string | null;
  intervalMs: number | null;
  apps: AppStatus[];
}

/** One down or recovered transition (mirrors core-api's `AlertRecord`, src/alerts.ts). */
export interface AlertRecord {
  at: string;
  kind: "down" | "recovered";
  id: string;
  name: string;
  live: AppStatus["live"];
  ready: AppStatus["ready"];
  error?: string;
  detail?: string;
}

export interface AlertHistory {
  /** Whether core-api sends alerts to a webhook (never its URL). */
  webhook: boolean;
  downRounds: number | null;
  /** Newest first; the last 50, kept in core-api's memory. */
  alerts: AlertRecord[];
}

export interface RoleGrant {
  subject: string;
  granted_by: string;
  granted_at: string;
}

const base = () => (process.env.CORE_API_URL ?? "http://localhost:4020").replace(/\/$/, "");

/** How long a call may take. The backup check hashes every backup file, so it gets longer. */
const TIMEOUT_MS = 8000;
export const BACKUP_CHECK_TIMEOUT_MS = 60_000;

async function call<T>(
  idToken: string,
  method: string,
  path: string,
  body?: object,
  timeoutMs: number = TIMEOUT_MS,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${idToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      // Next.js caches GET fetches in development; an admin must never see a stale list.
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if ((e as { name?: unknown } | null)?.name === "TimeoutError")
      throw new CoreApiError(0, "timeout", `core-api didn't answer within ${Math.round(timeoutMs / 1000)} s.`);
    throw new CoreApiError(0, "unreachable", "core-api isn't reachable right now.");
  }
  const payload = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok)
    throw new CoreApiError(res.status, payload.error ?? "error", payload.message ?? `core-api answered ${res.status}`);
  return payload as T;
}

export function coreApi(idToken: string) {
  const enc = encodeURIComponent;
  return {
    session: () => call<{ actor: string; subject: string }>(idToken, "GET", "/admin/v1/session"),
    /**
     * The apps the signed-in admin can open (the top bar's app switcher). An answer that isn't the
     * launcher contract is an empty list: the switcher must never break the console.
     */
    launcher: async (): Promise<LauncherTile[]> =>
      parseLauncher(await call<unknown>(idToken, "GET", "/admin/v1/launcher")) ?? [],
    apps: async () => (await call<{ apps: AdminApp[] }>(idToken, "GET", "/admin/v1/apps")).apps,
    events: async () => (await call<{ events: CatalogEntry[] }>(idToken, "GET", "/admin/v1/events")).events,
    status: () => call<StatusReport>(idToken, "GET", "/admin/v1/status"),
    alerts: () => call<AlertHistory>(idToken, "GET", "/admin/v1/alerts"),
    roles: async (app?: string) =>
      (await call<{ roles: AdminRole[] }>(idToken, "GET", `/admin/v1/roles${app ? `?app=${enc(app)}` : ""}`)).roles,
    roleGrants: async (role: string) =>
      (await call<{ grants: RoleGrant[] }>(idToken, "GET", `/admin/v1/roles/${enc(role)}/grants`)).grants,
    audit: (f: { app?: string; actor?: string; before?: number; limit?: number } = {}) => {
      const q = new URLSearchParams();
      if (f.app) q.set("app", f.app);
      if (f.actor) q.set("actor", f.actor);
      if (f.before) q.set("before", String(f.before));
      if (f.limit) q.set("limit", String(f.limit));
      return call<{ events: AuditEvent[]; next: number | null }>(idToken, "GET", `/admin/v1/audit?${q}`);
    },
    activate: (app: string) => call<{ state: string }>(idToken, "POST", `/admin/v1/apps/${enc(app)}/activate`),
    deactivate: (app: string) => call<{ state: string }>(idToken, "POST", `/admin/v1/apps/${enc(app)}/deactivate`),
    /** Remove (#68): from installed or inactive. core-api tears down its event plumbing, credentials and grants. */
    remove: (app: string) => call<RemoveResult>(idToken, "POST", `/admin/v1/apps/${enc(app)}/remove`),
    /**
     * Purge: drop a removed app's database and role. After its retention window, or earlier with
     * `force` and the app id typed as `confirm`. core-api checks the backup first.
     */
    purge: (app: string, opts: { force: boolean; confirm: string }) =>
      call<PurgeResult>(idToken, "POST", `/admin/v1/apps/${enc(app)}/purge`, opts),
    /**
     * Removed apps' retention with each backup file checked now against its recorded sha256
     * (`GET /admin/v1/retention?verify=true`, read-only). Read the verdicts with `backupVerdicts`.
     */
    verifyBackups: () =>
      call<unknown>(idToken, "GET", "/admin/v1/retention?verify=true", undefined, BACKUP_CHECK_TIMEOUT_MS),
    grant: (role: string, subject: string) =>
      call<{ granted: boolean }>(idToken, "PUT", `/admin/v1/roles/${enc(role)}/grants/${enc(subject)}`),
    revoke: (role: string, subject: string) =>
      call<{ revoked: boolean }>(idToken, "DELETE", `/admin/v1/roles/${enc(role)}/grants/${enc(subject)}`),
  };
}
