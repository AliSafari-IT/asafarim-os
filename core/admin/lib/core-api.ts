/**
 * The console's one connection to core-api: the admin API, called on behalf of the signed-in
 * administrator with THEIR identity ID token (core-api verifies it and checks `core.admin`
 * itself, per request, and audits the action as `user:<sub>`). The console holds no admin
 * secret of its own.
 */

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

export interface RoleGrant {
  subject: string;
  granted_by: string;
  granted_at: string;
}

const base = () => (process.env.CORE_API_URL ?? "http://localhost:4020").replace(/\/$/, "");

async function call<T>(idToken: string, method: string, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: { authorization: `Bearer ${idToken}` },
      // Next.js caches GET fetches in development; an admin must never see a stale list.
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new CoreApiError(0, "unreachable", "core-api isn't reachable right now.");
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok)
    throw new CoreApiError(res.status, body.error ?? "error", body.message ?? `core-api answered ${res.status}`);
  return body as T;
}

export function coreApi(idToken: string) {
  const enc = encodeURIComponent;
  return {
    session: () => call<{ actor: string; subject: string }>(idToken, "GET", "/admin/v1/session"),
    apps: async () => (await call<{ apps: AdminApp[] }>(idToken, "GET", "/admin/v1/apps")).apps,
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
    grant: (role: string, subject: string) =>
      call<{ granted: boolean }>(idToken, "PUT", `/admin/v1/roles/${enc(role)}/grants/${enc(subject)}`),
    revoke: (role: string, subject: string) =>
      call<{ revoked: boolean }>(idToken, "DELETE", `/admin/v1/roles/${enc(role)}/grants/${enc(subject)}`),
  };
}
