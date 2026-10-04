/**
 * Read-only queries for the Admin console (P3.3b): apps, roles and who holds them,
 * a person's grants, and the audit log. Everything here is a SELECT; the writes
 * (install, activate, grant…) stay in the registry, where each one is audited.
 */
import type pg from "pg";
import { CORE_ADMIN_ROLE } from "./admin-auth.ts";

export interface AdminApp {
  id: string;
  name: string;
  version: string;
  state: string;
  /** Built in (the `core` catalog): can't be deactivated or removed. */
  system: boolean;
  installed_at: string;
  registered_at: string | null;
  permissions: number;
  roles: number;
}

export interface AdminRole {
  key: string;
  appId: string;
  description: string | null;
  deprecated: boolean;
  permissions: { key: string; deprecated: boolean }[];
  /** Permissions this role still grants although the app no longer declares them (ADR 0001 §3.4). */
  deprecatedPermissions: string[];
  /** True when something has to be migrated: the role still grants a deprecated permission. */
  migrationNeeded: boolean;
  holders: number;
}

export interface AuditFilter {
  app?: string;
  /** A case-insensitive part of the actor (e.g. "dev-admin"). */
  actor?: string;
  limit?: number;
  /** Return events older than this id (paging). */
  before?: number;
}

export function createAdminQueries(pool: pg.Pool) {
  async function holdsRole(role: string, subject: string): Promise<boolean> {
    const r = await pool.query(
      `SELECT 1 FROM role_grants g JOIN roles r ON r.key = g.role_key
       WHERE g.role_key = $1 AND g.subject = $2 AND r.deprecated_at IS NULL`,
      [role, subject],
    );
    return r.rows.length > 0;
  }

  async function listApps(): Promise<AdminApp[]> {
    const r = await pool.query(
      `SELECT a.id, a.manifest->>'name' AS name, a.version, a.state, a.installed_at, a.registered_at,
              (SELECT count(*) FROM permissions p WHERE p.app_id = a.id AND p.deprecated_at IS NULL) AS permissions,
              (SELECT count(*) FROM roles r WHERE r.app_id = a.id AND r.deprecated_at IS NULL) AS roles
         FROM apps a WHERE a.state <> 'removed' ORDER BY (a.id = 'core') DESC, a.id`,
    );
    return r.rows.map((x) => ({
      id: x.id,
      name: x.name ?? x.id,
      version: x.version,
      state: x.state,
      system: x.id === "core",
      installed_at: new Date(x.installed_at).toISOString(),
      registered_at: x.registered_at ? new Date(x.registered_at).toISOString() : null,
      permissions: Number(x.permissions),
      roles: Number(x.roles),
    }));
  }

  /** Roles (optionally one app's) with their permissions, holders, and what needs migrating. */
  async function listRoles(appId?: string): Promise<AdminRole[]> {
    const roles = await pool.query(
      `SELECT r.key, r.app_id, r.description, r.deprecated_at,
              (SELECT count(*) FROM role_grants g WHERE g.role_key = r.key) AS holders
         FROM roles r WHERE ($1::text IS NULL OR r.app_id = $1) ORDER BY r.app_id, r.key`,
      [appId ?? null],
    );
    const perms = await pool.query(
      `SELECT rp.role_key, p.key, p.deprecated_at FROM role_permissions rp
         JOIN permissions p ON p.key = rp.permission_key
         JOIN roles r ON r.key = rp.role_key
        WHERE ($1::text IS NULL OR r.app_id = $1) ORDER BY p.key`,
      [appId ?? null],
    );
    return roles.rows.map((r) => {
      const mine = perms.rows.filter((p) => p.role_key === r.key);
      const deprecatedPermissions = mine.filter((p) => p.deprecated_at).map((p) => p.key as string);
      return {
        key: r.key,
        appId: r.app_id,
        description: r.description,
        deprecated: r.deprecated_at !== null,
        permissions: mine.map((p) => ({ key: p.key, deprecated: p.deprecated_at !== null })),
        deprecatedPermissions,
        migrationNeeded: deprecatedPermissions.length > 0,
        holders: Number(r.holders),
      };
    });
  }

  async function roleGrants(role: string) {
    const r = await pool.query(
      "SELECT subject, granted_by, granted_at FROM role_grants WHERE role_key = $1 ORDER BY subject",
      [role],
    );
    return r.rows.map((x) => ({
      subject: x.subject as string,
      granted_by: x.granted_by as string,
      granted_at: new Date(x.granted_at).toISOString(),
    }));
  }

  /** Every role a person holds, across apps. */
  async function subjectGrants(subject: string) {
    const r = await pool.query(
      `SELECT g.role_key, r.app_id, g.granted_by, g.granted_at FROM role_grants g JOIN roles r ON r.key = g.role_key
        WHERE g.subject = $1 ORDER BY r.app_id, g.role_key`,
      [subject],
    );
    return r.rows.map((x) => ({
      role: x.role_key as string,
      appId: x.app_id as string,
      granted_by: x.granted_by as string,
      granted_at: new Date(x.granted_at).toISOString(),
    }));
  }

  /** The audit log, newest first, filterable by app and by (part of) the actor. */
  async function audit(f: AuditFilter = {}) {
    const limit = Math.min(Math.max(Math.trunc(f.limit ?? 50), 1), 200);
    const r = await pool.query(
      `SELECT id, at, actor, action, app_id, detail FROM audit_events
        WHERE ($1::text IS NULL OR app_id = $1)
          AND ($2::text IS NULL OR position(lower($2) in lower(actor)) > 0)
          AND ($3::bigint IS NULL OR id < $3)
        ORDER BY id DESC LIMIT $4`,
      [f.app ?? null, f.actor ?? null, f.before ?? null, limit + 1],
    );
    const rows = r.rows.slice(0, limit).map((x) => ({
      id: Number(x.id),
      at: new Date(x.at).toISOString(),
      actor: x.actor as string,
      action: x.action as string,
      appId: x.app_id as string | null,
      detail: x.detail as Record<string, unknown>,
    }));
    return { events: rows, next: r.rows.length > limit ? rows[rows.length - 1]!.id : null };
  }

  return { holdsRole, listApps, listRoles, roleGrants, subjectGrants, audit, CORE_ADMIN_ROLE };
}

export type AdminQueries = ReturnType<typeof createAdminQueries>;
