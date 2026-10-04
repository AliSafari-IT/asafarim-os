/**
 * The app registry (P3.1, ADR 0001 §3): install, signed self-registration,
 * lifecycle, and the permission catalog that apps DECLARE and admins GRANT.
 *
 * Safety rules, each enforced here and tested:
 *  - registration can't grant anything: it never writes role_grants and
 *    never changes an app's state;
 *  - an app may only declare permissions, roles, routes and published events
 *    inside its own namespace (`<id>.*`);
 *  - an unknown app (no install record, or removed) can't register;
 *  - a bad, expired or replayed signature is refused.
 */
import { randomBytes } from "node:crypto";
import { validateManifest, type AppManifest } from "@asafarim/app-manifest";
import { signAccessToken, type SigningKey } from "@asafarim/registry-protocol";
import type pg from "pg";
import { ApiError } from "./errors.ts";
import {
  NONCE_PATTERN,
  SIGNATURE_WINDOW_SECONDS,
  canonicalString,
  ed25519Scheme,
  type CredentialScheme,
} from "./credentials.ts";
import { appDatabaseNames, ensureDatabase, ensureRole } from "./provision.ts";

export type AppState = "installed" | "active" | "inactive" | "removed";

export interface RegistryDeps {
  pool: pg.Pool;
  /** A connection that may CREATE ROLE / CREATE DATABASE (app install). */
  provisioner: () => Promise<pg.Client>;
  /** How app databases are reached, for the URL handed to the app at install. */
  appDatabaseHost: { host: string; port: number };
  scheme?: CredentialScheme;
  now?: () => Date;
  /** Signs the short-lived access tokens (P3.3a). Without it, issuing one is refused. */
  tokenKey?: SigningKey;
  /** Called after every change that the gateway must see at once (install, activate, deactivate). */
  onLifecycleChange?: () => void;
}

/** Parse and validate a manifest; refuse an id mismatch and anything outside the namespace. */
export function checkManifest(appId: string, input: unknown): AppManifest {
  const result = validateManifest(input);
  if (!result.ok) {
    // The validator's namespace rules surface as their own error code.
    const ns = result.problems.filter((p) => /namespace/.test(p.message));
    throw new ApiError(
      ns.length ? "namespace_violation" : "invalid_manifest",
      "the manifest is invalid",
      result.problems,
    );
  }
  const m = result.manifest;
  if (m.id !== appId) throw new ApiError("app_id_mismatch", `manifest.id "${m.id}" ≠ "${appId}"`);

  // Defence in depth: re-check the namespace here, independently of the validator.
  const ns = `${appId}.`;
  const outside: string[] = [];
  for (const p of m.permissions) if (!p.key.startsWith(ns)) outside.push(`permission ${p.key}`);
  for (const r of m.roles) {
    if (!r.key.startsWith(ns)) outside.push(`role ${r.key}`);
    for (const g of r.grants) if (!g.startsWith(ns)) outside.push(`grant ${g}`);
  }
  for (const r of m.routes ?? [])
    if (r.permission && !r.permission.startsWith(ns)) outside.push(`route permission ${r.permission}`);
  for (const e of m.events?.publishes ?? []) if (!e.type.startsWith(ns)) outside.push(`event ${e.type}`);
  if (outside.length) throw new ApiError("namespace_violation", `outside "${ns}*": ${outside.join(", ")}`);
  return m;
}

async function audit(
  db: pg.PoolClient | pg.Pool,
  actor: string,
  action: string,
  appId: string | null,
  detail: object = {},
) {
  await db.query("INSERT INTO audit_events (actor, action, app_id, detail) VALUES ($1, $2, $3, $4)", [
    actor,
    action,
    appId,
    detail,
  ]);
}

export function createRegistry(deps: RegistryDeps) {
  const scheme = deps.scheme ?? ed25519Scheme;
  const now = deps.now ?? (() => new Date());

  async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await deps.pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  }

  /** Admin: install an app. Returns the credential and DB password ONCE. */
  async function install(appId: string, manifestInput: unknown, actor: string) {
    const manifest = checkManifest(appId, manifestInput);
    const existing = await deps.pool.query<{ state: AppState }>("SELECT state FROM apps WHERE id = $1", [appId]);
    if (existing.rows[0] && existing.rows[0].state !== "removed") throw new ApiError("already_installed");

    // The app's own database and login role (the OS-D1 bootstrap helper).
    const { database, role } = appDatabaseNames(appId);
    const dbPassword = randomBytes(24).toString("base64url");
    const prov = await deps.provisioner();
    let roleResult: string;
    let dbResult: string;
    try {
      roleResult = await ensureRole(prov, role, dbPassword);
      dbResult = await ensureDatabase(prov, database, role);
    } finally {
      await prov.end();
    }

    const credential = scheme.issue(appId);
    await inTx(async (c) => {
      await c.query(
        `INSERT INTO apps (id, version, manifest, state, database_name) VALUES ($1, $2, $3, 'installed', $4)
         ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, manifest = EXCLUDED.manifest, state = 'installed',
           database_name = EXCLUDED.database_name, installed_at = now(), updated_at = now()`,
        [appId, manifest.version, manifest, database],
      );
      await c.query("UPDATE app_credentials SET revoked_at = now() WHERE app_id = $1 AND revoked_at IS NULL", [appId]);
      await c.query("INSERT INTO app_credentials (key_id, app_id, scheme, verifier) VALUES ($1, $2, $3, $4)", [
        credential.keyId,
        appId,
        credential.scheme,
        credential.verifier,
      ]);
      await audit(c, actor, "app.installed", appId, {
        version: manifest.version,
        database,
        role: roleResult,
        db: dbResult,
        keyId: credential.keyId,
      });
    });

    deps.onLifecycleChange?.();
    const h = deps.appDatabaseHost;
    return {
      appId,
      state: "installed" as AppState,
      credential: credential.secret,
      keyId: credential.keyId,
      database: { name: database, role, url: `postgres://${role}:${dbPassword}@${h.host}:${h.port}/${database}` },
    };
  }

  /**
   * Forget nonces that can no longer be replayed. A signature is accepted for
   * ±SIGNATURE_WINDOW_SECONDS around its timestamp, so a nonce must be kept
   * for twice that window (first use at the far edge of the future side).
   * Runs on every registration and on a timer in the server; returns how many.
   */
  async function pruneNonces(): Promise<number> {
    const r = await deps.pool.query("DELETE FROM registry_nonces WHERE expires_at < now()");
    return r.rowCount ?? 0;
  }

  /** Verify the signed request; returns the app's current state. Doesn't touch the catalog. */
  async function authenticate(
    appId: string,
    method: string,
    path: string,
    headers: Record<string, string | undefined>,
    body: string,
  ) {
    const ts = headers["x-asafarim-timestamp"];
    const nonce = headers["x-asafarim-nonce"];
    const keyId = headers["x-asafarim-key-id"];
    const sig = /^v1=([A-Za-z0-9_-]+)$/.exec(headers["x-asafarim-signature"] ?? "")?.[1];
    if (!ts || !nonce || !keyId || !sig || !/^\d{1,12}$/.test(ts) || !NONCE_PATTERN.test(nonce)) {
      throw new ApiError("missing_signature");
    }

    // An unknown or removed app has no credential to verify against.
    const app = await deps.pool.query<{ state: AppState }>("SELECT state FROM apps WHERE id = $1", [appId]);
    if (!app.rows[0] || app.rows[0].state === "removed") throw new ApiError("unknown_app");

    const cred = await deps.pool.query<{ scheme: string; verifier: string }>(
      "SELECT scheme, verifier FROM app_credentials WHERE key_id = $1 AND app_id = $2 AND revoked_at IS NULL",
      [keyId, appId],
    );
    const c = cred.rows[0];
    if (
      !c ||
      c.scheme !== scheme.name ||
      !scheme.verify(c.verifier, canonicalString(ts, nonce, method, path, body), Buffer.from(sig, "base64url"))
    ) {
      throw new ApiError("bad_signature");
    }
    // Only a verified request reaches the clock and the replay cache, so a
    // forged one can't burn a real nonce.
    const skew = Math.abs(now().getTime() / 1000 - Number(ts));
    if (skew > SIGNATURE_WINDOW_SECONDS) throw new ApiError("expired_signature");
    await pruneNonces();
    const fresh = await deps.pool.query(
      "INSERT INTO registry_nonces (nonce, app_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3)) ON CONFLICT DO NOTHING",
      [nonce, appId, SIGNATURE_WINDOW_SECONDS * 2],
    );
    if (fresh.rowCount === 0) throw new ApiError("replayed_signature");
    return app.rows[0].state;
  }

  /** The app's signed self-registration: upsert manifest, permissions, roles, subscriptions. */
  async function register(appId: string, headers: Record<string, string | undefined>, body: string) {
    const state = await authenticate(appId, "POST", `/registry/v1/apps/${appId}`, headers, body);
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      throw new ApiError("bad_request", "the body must be the manifest as JSON");
    }
    const m = checkManifest(appId, input);

    return inTx(async (c) => {
      await c.query(
        "UPDATE apps SET version = $2, manifest = $3, registered_at = now(), updated_at = now() WHERE id = $1",
        [appId, m.version, m],
      );

      // Permissions: add new, restore re-declared, deprecate removed (never delete).
      const declared = new Map(m.permissions.map((p) => [p.key, p.description]));
      const before = (
        await c.query<{ key: string; deprecated_at: Date | null }>(
          "SELECT key, deprecated_at FROM permissions WHERE app_id = $1",
          [appId],
        )
      ).rows;
      const perms = { added: [] as string[], restored: [] as string[], deprecated: [] as string[] };
      for (const [key, description] of declared) {
        const prev = before.find((p) => p.key === key);
        if (!prev) perms.added.push(key);
        else if (prev.deprecated_at) perms.restored.push(key);
        await c.query(
          `INSERT INTO permissions (key, app_id, description) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, deprecated_at = NULL, updated_at = now()`,
          [key, appId, description],
        );
      }
      for (const p of before) {
        if (!declared.has(p.key) && !p.deprecated_at) {
          perms.deprecated.push(p.key);
          await c.query("UPDATE permissions SET deprecated_at = now(), updated_at = now() WHERE key = $1", [p.key]);
        }
      }

      // Roles: the same rules. A role's permissions are the app's own (validated).
      const roleKeys = new Set(m.roles.map((r) => r.key));
      const beforeRoles = (
        await c.query<{ key: string; deprecated_at: Date | null }>(
          "SELECT key, deprecated_at FROM roles WHERE app_id = $1",
          [appId],
        )
      ).rows;
      const roles = { added: [] as string[], deprecated: [] as string[] };
      for (const r of m.roles) {
        if (!beforeRoles.some((b) => b.key === r.key)) roles.added.push(r.key);
        await c.query(
          `INSERT INTO roles (key, app_id, description) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, deprecated_at = NULL, updated_at = now()`,
          [r.key, appId, r.description ?? null],
        );
        await c.query("DELETE FROM role_permissions WHERE role_key = $1", [r.key]);
        const grants = r.grants.includes(`${appId}.*`) ? [...declared.keys()] : r.grants;
        for (const g of grants)
          await c.query(
            "INSERT INTO role_permissions (role_key, permission_key) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [r.key, g],
          );
      }
      for (const b of beforeRoles) {
        if (!roleKeys.has(b.key) && !b.deprecated_at) {
          roles.deprecated.push(b.key);
          await c.query("UPDATE roles SET deprecated_at = now(), updated_at = now() WHERE key = $1", [b.key]);
        }
      }

      // Event subscriptions: exactly what the manifest declares now.
      await c.query("DELETE FROM event_subscriptions WHERE app_id = $1", [appId]);
      for (const s of m.events?.subscribes ?? []) {
        await c.query("INSERT INTO event_subscriptions (app_id, event_type, handler) VALUES ($1, $2, $3)", [
          appId,
          s.type,
          s.handler,
        ]);
      }

      await audit(c, `app:${appId}`, "app.registered", appId, { version: m.version, permissions: perms, roles });
      // Registration never changes the state and never writes role_grants.
      return { appId, version: m.version, state, permissions: perms, roles };
    });
  }

  const TRANSITIONS: Record<"activate" | "deactivate", { from: AppState[]; to: AppState }> = {
    activate: { from: ["installed", "inactive"], to: "active" },
    deactivate: { from: ["active"], to: "inactive" },
  };

  /** Admin: activate / deactivate. Gateway and launcher effects arrive in P3.3. */
  async function transition(appId: string, action: "activate" | "deactivate", actor: string) {
    const t = TRANSITIONS[action];
    const out = await inTx(async (c) => {
      const row = (await c.query<{ state: AppState }>("SELECT state FROM apps WHERE id = $1 FOR UPDATE", [appId]))
        .rows[0];
      if (!row) throw new ApiError("not_found", `no app "${appId}"`);
      if (!t.from.includes(row.state))
        throw new ApiError("invalid_state", `can't ${action} an app that is ${row.state}`);
      await c.query("UPDATE apps SET state = $2, updated_at = now() WHERE id = $1", [appId, t.to]);
      await audit(c, actor, `app.${action}d`, appId, { from: row.state, to: t.to });
      return { appId, state: t.to, previous: row.state };
    });
    deps.onLifecycleChange?.(); // the gateway serves (or stops serving) the app from this moment
    return out;
  }

  /**
   * The app asks (signed GET) what a subject may do in THIS app: the roles an
   * admin granted them and the permissions those roles carry. Deprecated roles
   * and permissions grant nothing. The app's state is returned too, so an
   * inactive app can say so. Read-only; nothing here grants anything.
   */
  async function subjectAccess(
    appId: string,
    subject: string,
    headers: Record<string, string | undefined>,
    /** The request path exactly as the app signed it (percent-encoded). */
    path = `/registry/v1/apps/${appId}/subjects/${encodeURIComponent(subject)}`,
  ) {
    const state = await authenticate(appId, "GET", path, headers, "");
    return { appId, subject, state, ...(await grantsOf(appId, subject)) };
  }

  /** The roles an admin granted `subject` in this app, and the permissions those carry. Deprecated ones grant nothing. */
  async function grantsOf(appId: string, subject: string) {
    const roles = (
      await deps.pool.query<{ key: string }>(
        `SELECT g.role_key AS key FROM role_grants g JOIN roles r ON r.key = g.role_key
         WHERE g.subject = $1 AND r.app_id = $2 AND r.deprecated_at IS NULL ORDER BY g.role_key`,
        [subject, appId],
      )
    ).rows.map((r) => r.key);
    const permissions = (
      await deps.pool.query<{ key: string }>(
        `SELECT DISTINCT p.key FROM role_grants g
           JOIN roles r ON r.key = g.role_key AND r.deprecated_at IS NULL
           JOIN role_permissions rp ON rp.role_key = r.key
           JOIN permissions p ON p.key = rp.permission_key AND p.deprecated_at IS NULL
         WHERE g.subject = $1 AND r.app_id = $2 ORDER BY p.key`,
        [subject, appId],
      )
    ).rows.map((r) => r.key);
    return { roles, permissions };
  }

  /**
   * The app asks (signed POST, bound to this subject's path) for a short-lived
   * access token for a person it has signed in: the gateway and the SDK verify
   * it locally. The token carries this app's permissions only (audience = the
   * app) and lives ACCESS_TOKEN_TTL_SECONDS. Only an ACTIVE app gets one.
   */
  async function issueAccessToken(
    appId: string,
    subject: string,
    headers: Record<string, string | undefined>,
    /** The request path exactly as the app signed it (percent-encoded). */
    path = `/registry/v1/apps/${appId}/subjects/${encodeURIComponent(subject)}/token`,
  ) {
    if (!deps.tokenKey) throw new ApiError("bad_request", "this core-api has no token signing key configured");
    const state = await authenticate(appId, "POST", path, headers, "");
    if (state !== "active") throw new ApiError("app_inactive", `the app is ${state}`);
    const { permissions } = await grantsOf(appId, subject);
    const { token, claims } = signAccessToken({
      key: deps.tokenKey,
      subject,
      audience: appId,
      permissions,
      now: now(),
    });
    return { token, expiresAt: new Date(claims.exp * 1000).toISOString(), expiresIn: claims.exp - claims.iat };
  }

  /** Admin: give a subject a role (an app's declared role). Idempotent; audited. */
  async function grantRole(roleKey: string, subject: string, actor: string) {
    return inTx(async (c) => {
      const role = (await c.query("SELECT app_id FROM roles WHERE key = $1 AND deprecated_at IS NULL", [roleKey]))
        .rows[0];
      if (!role) throw new ApiError("role_not_found", `no active role "${roleKey}"`);
      const r = await c.query(
        "INSERT INTO role_grants (role_key, subject, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [roleKey, subject, actor],
      );
      if (r.rowCount) await audit(c, actor, "role.granted", role.app_id, { role: roleKey, subject });
      return { role: roleKey, subject, granted: (r.rowCount ?? 0) > 0 };
    });
  }

  async function revokeRole(roleKey: string, subject: string, actor: string) {
    return inTx(async (c) => {
      const role = (await c.query("SELECT app_id FROM roles WHERE key = $1", [roleKey])).rows[0];
      if (!role) throw new ApiError("role_not_found", `no role "${roleKey}"`);
      const r = await c.query("DELETE FROM role_grants WHERE role_key = $1 AND subject = $2", [roleKey, subject]);
      if (r.rowCount) await audit(c, actor, "role.revoked", role.app_id, { role: roleKey, subject });
      return { role: roleKey, subject, revoked: (r.rowCount ?? 0) > 0 };
    });
  }

  async function get(appId: string) {
    const app = (
      await deps.pool.query("SELECT id, version, state, installed_at, registered_at FROM apps WHERE id = $1", [appId])
    ).rows[0];
    if (!app) throw new ApiError("not_found", `no app "${appId}"`);
    const permissions = (
      await deps.pool.query("SELECT key, description, deprecated_at FROM permissions WHERE app_id = $1 ORDER BY key", [
        appId,
      ])
    ).rows;
    const roles = (
      await deps.pool.query("SELECT key, deprecated_at FROM roles WHERE app_id = $1 ORDER BY key", [appId])
    ).rows;
    return { ...app, permissions, roles };
  }

  return { install, register, transition, get, pruneNonces, subjectAccess, issueAccessToken, grantRole, revokeRole };
}

export type Registry = ReturnType<typeof createRegistry>;
