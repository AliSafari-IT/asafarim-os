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
import { checkEventSchemas } from "./event-schemas.ts";
import {
  WAITING_FOR_PUBLISHER,
  consumerOutcome,
  planEventPlumbing,
  planRemoval,
  publishedTypes,
  waitingForPublisher,
  type EventPlumbingPlan,
  type InstalledApp,
  type RemovalPlan,
} from "./event-plumbing.ts";
import { DEFAULT_RETENTION_DAYS, purgeAfter, type BackupFile, type DatabaseBackups } from "./backup.ts";
import { launcherFor, type LauncherApp } from "./launcher.ts";
import {
  appDatabaseNames,
  dropDatabaseAndRole,
  ensureDatabase,
  ensureRole,
  setRoleLogin,
  terminateConnections,
} from "./provision.ts";

export type AppState = "installed" | "active" | "inactive" | "removed";

/** The platform's own catalog (migration 002): always active, never installed, deactivated or removed. */
export const BUILT_IN_APP = "core";

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
  /** How long an access token lives, in seconds (default 60). This is also how long a revoked grant can still work. */
  accessTokenTtlSeconds?: number;
  /**
   * How long an install or registration waits for another one's event plumbing (the lock below),
   * in ms (default 10 000). After that it answers `503 registry_busy` and nothing is written, so
   * concurrent registrations can't hold the pool's connections indefinitely.
   */
  plumbingLockTimeoutMs?: number;
  /** Where an app opens in the launcher: `http://{id}.localhost:8080` in dev; unset = https://<primary domain>. */
  appUrlTemplate?: string;
  /** Called after every change that the gateway must see at once (install, activate, deactivate, remove). */
  onLifecycleChange?: () => void;
  /**
   * The event bus (P4.1): install and registration (an upgrade) create the JetStream stream of an
   * app that declares `events.publishes` (APP_<ID> on <id>.>), a durable consumer `<id>.<type>` for
   * every `events.subscribes` type whose publisher's stream exists (`waiting_for_publisher`
   * otherwise), the consumers of already installed subscribers of what a new publisher declares,
   * delete the consumers of subscriptions an upgrade dropped, and the other apps' consumers of types
   * an upgrade stops publishing (see event-plumbing.ts). Unset =
   * no bus configured: recorded as `no_bus`, nothing is created, and the app's events wait in its outbox.
   */
  bus?: EventBus;
  /**
   * Remove backs up the app's database here before anything is torn down (ADR 0001 §3 step 6), and a
   * purge checks that backup before it drops the database. Unset = an app with a database can't be
   * removed (`backup_failed`): its data would otherwise be kept with no backup to purge against.
   */
  backups?: DatabaseBackups;
  /** Days a removed app's database is kept before it may be purged (default 30, CORE_API_RETENTION_DAYS). */
  retentionDays?: number;
}

/** What the registry needs from the bus (`createStreamAdmin` from @asafarim/events). Idempotent. */
export interface EventBus {
  ensureAppStream(appId: string): Promise<{ stream: string; result: string }>;
  /** `result` is "no_stream" when the publisher's stream doesn't exist (yet): nothing is created. */
  ensureConsumer(consumerApp: string, type: string): Promise<{ consumer: string; result: string }>;
  /** `result` is "absent" when the consumer (or its stream) is already gone: not an error. */
  deleteConsumer(consumerApp: string, type: string): Promise<{ consumer: string; result: string }>;
  /** Delete the app's stream with its messages and consumers (remove). "absent" when it has none: not an error. */
  deleteAppStream(appId: string): Promise<{ stream: string; result: string }>;
}

type StreamOutcome = { stream: string; result: string } | "none" | "no_bus";
type PerType = Record<string, string> | "none" | "no_bus";
type PerApp = Record<string, Record<string, string>> | "none" | "no_bus";

/** What an install or a registration did on the bus, per type. In the response and the audit entry. */
export interface EventsOutcome {
  stream: StreamOutcome;
  /** The app's own subscriptions: created / updated / exists / waiting_for_publisher. */
  consumers: PerType;
  /** Subscriptions an upgrade dropped: their consumers deleted (or already absent). */
  removedConsumers: PerType;
  /** Installed subscribers of what this app publishes, by app, then type. */
  dependentConsumers: PerApp;
  /** Other apps' consumers of the types an upgrade stopped publishing, by app, then type: deleted / absent. */
  orphanedConsumers: PerApp;
  /**
   * Subscriptions whose publisher isn't installed: nothing is blocked, the consumer comes with the
   * publisher. Without `app`: this app's own subscriptions. With `app`: another app's subscription
   * that waits again because this upgrade stopped publishing its type.
   */
  warnings: { app?: string; type: string; code: typeof WAITING_FOR_PUBLISHER }[];
}

/** Serialises event plumbing across concurrent installs/registrations (a publisher and its subscriber at once). */
const EVENT_PLUMBING_LOCK = 4_049_100_053;

/**
 * Run the plan on the bus. Called inside the install/registration transaction, under the event
 * plumbing lock, BEFORE anything is written: a bus failure throws `bus_unavailable`, the
 * transaction rolls back, nothing is recorded, and the caller can retry (every step is idempotent).
 */
async function runEventPlumbing(
  bus: EventBus | undefined,
  appId: string,
  plan: EventPlumbingPlan,
  waiting: string[],
): Promise<EventsOutcome> {
  const out: EventsOutcome = {
    stream: plan.stream ? "no_bus" : "none",
    consumers: plan.own.length ? "no_bus" : "none",
    removedConsumers: plan.remove.length ? "no_bus" : "none",
    dependentConsumers: plan.dependents.length ? "no_bus" : "none",
    orphanedConsumers: plan.orphaned.length ? "no_bus" : "none",
    warnings: [],
  };
  const warn = new Set(waiting);
  if (bus) {
    try {
      if (plan.stream) out.stream = await bus.ensureAppStream(appId);
      if (plan.own.length) {
        const consumers: Record<string, string> = {};
        for (const type of plan.own) {
          consumers[type] = consumerOutcome((await bus.ensureConsumer(appId, type)).result);
          if (consumers[type] === WAITING_FOR_PUBLISHER) warn.add(type);
        }
        out.consumers = consumers;
      }
      if (plan.dependents.length) {
        const deps: Record<string, Record<string, string>> = {};
        for (const { app, type } of plan.dependents)
          (deps[app] ??= {})[type] = consumerOutcome((await bus.ensureConsumer(app, type)).result);
        out.dependentConsumers = deps;
      }
      if (plan.orphaned.length) {
        const orphaned: Record<string, Record<string, string>> = {};
        for (const { app, type } of plan.orphaned)
          (orphaned[app] ??= {})[type] = (await bus.deleteConsumer(app, type)).result;
        out.orphanedConsumers = orphaned;
      }
      if (plan.remove.length) {
        const removed: Record<string, string> = {};
        for (const type of plan.remove) removed[type] = (await bus.deleteConsumer(appId, type)).result;
        out.removedConsumers = removed;
      }
    } catch (err) {
      throw new ApiError(
        "bus_unavailable",
        `the event plumbing for ${appId} couldn't be set up: ${(err as Error).message}`,
      );
    }
  }
  out.warnings = [
    ...[...warn].sort().map((type) => ({ type, code: WAITING_FOR_PUBLISHER }) as const),
    // The subscription waits whether or not a bus is configured: its type has no publisher any more.
    ...plan.orphaned.map(({ app, type }) => ({ app, type, code: WAITING_FOR_PUBLISHER }) as const),
  ];
  return out;
}

/** What a removal did on the bus. In the response and the `app.removed` audit entry. */
export interface RemovalOutcome {
  /** The app's own consumers: deleted / absent. */
  consumers: PerType;
  /** Other installed apps' consumers on its stream, by app, then type: deleted / absent. */
  dependentConsumers: PerApp;
  /** Its stream APP_<ID>: deleted / absent. */
  stream: StreamOutcome;
  /** The other apps' subscriptions that now wait for a publisher. */
  warnings: { app: string; type: string; code: typeof WAITING_FOR_PUBLISHER }[];
}

/**
 * Run a removal plan on the bus, like runEventPlumbing: inside the transaction, under the plumbing
 * lock, before anything is written. Consumers first, then the stream (which would take its consumers
 * with it, but deleting them by name keeps the outcome explicit). A failure → `bus_unavailable`.
 */
async function runRemoval(bus: EventBus | undefined, appId: string, plan: RemovalPlan): Promise<RemovalOutcome> {
  const out: RemovalOutcome = {
    consumers: plan.own.length ? "no_bus" : "none",
    dependentConsumers: plan.dependents.length ? "no_bus" : "none",
    stream: "no_bus",
    warnings: plan.dependents.map(({ app, type }) => ({ app, type, code: WAITING_FOR_PUBLISHER })),
  };
  if (!bus) return out;
  try {
    if (plan.own.length) {
      const own: Record<string, string> = {};
      for (const type of plan.own) own[type] = (await bus.deleteConsumer(appId, type)).result;
      out.consumers = own;
    }
    if (plan.dependents.length) {
      const deps: Record<string, Record<string, string>> = {};
      for (const { app, type } of plan.dependents)
        (deps[app] ??= {})[type] = (await bus.deleteConsumer(app, type)).result;
      out.dependentConsumers = deps;
    }
    out.stream = await bus.deleteAppStream(appId);
  } catch (err) {
    throw new ApiError(
      "bus_unavailable",
      `the event plumbing of ${appId} couldn't be removed: ${(err as Error).message}`,
    );
  }
  return out;
}

/** Default wait for the plumbing lock (`plumbingLockTimeoutMs`). */
export const PLUMBING_LOCK_TIMEOUT_MS = 10_000;

/**
 * Take the plumbing lock (waiting at most `timeoutMs`, else `registry_busy`) and read the other
 * installed apps (their current manifests).
 */
async function lockAndReadInstalled(c: pg.PoolClient, appId: string, timeoutMs: number): Promise<InstalledApp[]> {
  // SET LOCAL: only for this transaction. lock_timeout covers waiting on an advisory lock.
  await c.query(`SET LOCAL lock_timeout = ${Math.max(1, Math.trunc(timeoutMs))}`);
  try {
    await c.query("SELECT pg_advisory_xact_lock($1)", [EVENT_PLUMBING_LOCK]);
  } catch (err) {
    if ((err as { code?: string }).code === "55P03") {
      throw new ApiError("registry_busy", "another install or registration is setting up event plumbing; retry");
    }
    throw err;
  }
  await c.query("SET LOCAL lock_timeout = 0");
  return (
    await c.query<InstalledApp>("SELECT id, manifest FROM apps WHERE state <> 'removed' AND id <> $1 ORDER BY id", [
      appId,
    ])
  ).rows;
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

/**
 * Drop the catalog schemas (P4.2) of the types `manifest` no longer publishes, so the catalog never
 * lists a type nobody publishes. Runs in the install/registration transaction. Returns the types dropped.
 */
async function pruneEventSchemas(c: pg.PoolClient, appId: string, manifest: AppManifest): Promise<string[]> {
  const r = await c.query<{ event_type: string }>(
    "DELETE FROM event_schemas WHERE app_id = $1 AND NOT (event_type = ANY($2::text[])) RETURNING event_type",
    [appId, publishedTypes(manifest)],
  );
  return r.rows.map((x) => x.event_type).sort();
}

export function createRegistry(deps: RegistryDeps) {
  const scheme = deps.scheme ?? ed25519Scheme;
  const now = deps.now ?? (() => new Date());
  const lockTimeoutMs = deps.plumbingLockTimeoutMs ?? PLUMBING_LOCK_TIMEOUT_MS;

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
    if (appId === BUILT_IN_APP) throw new ApiError("already_installed", `"${appId}" is built in`);
    const existing = await deps.pool.query<{ state: AppState }>("SELECT state FROM apps WHERE id = $1", [appId]);
    if (existing.rows[0] && existing.rows[0].state !== "removed") throw new ApiError("already_installed");

    // The app's own database and login role (the OS-D1 bootstrap helper), unless it says it has none.
    const wantsDatabase = manifest.database.engine !== "none";
    const { database, role } = appDatabaseNames(appId);
    const dbPassword = randomBytes(24).toString("base64url");
    let roleResult = "none";
    let dbResult = "none";
    if (wantsDatabase) {
      const prov = await deps.provisioner();
      try {
        roleResult = await ensureRole(prov, role, dbPassword);
        dbResult = await ensureDatabase(prov, database, role);
      } finally {
        await prov.end();
      }
    }

    const credential = scheme.issue(appId);
    const events = await inTx(async (c) => {
      // The app's stream and consumers (and those of subscribers installed before it), before
      // anything is recorded: if the bus can't create them, the transaction rolls back, nothing is
      // installed and the admin can simply retry (the database and role steps are idempotent).
      const installed = await lockAndReadInstalled(c, appId, lockTimeoutMs);
      const plan = planEventPlumbing({ appId, manifest, installed });
      const events = await runEventPlumbing(deps.bus, appId, plan, waitingForPublisher(appId, manifest, installed));

      // A reinstall (after removal) waits for the app to register again, like a first install. Before a
      // purge it keeps the app's database (ensureDatabase above found it: `db: "exists"`), so the
      // retention clock stops; after one, the database is a new, empty one.
      await c.query(
        `INSERT INTO apps (id, version, manifest, state, database_name) VALUES ($1, $2, $3, 'installed', $4)
         ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, manifest = EXCLUDED.manifest, state = 'installed',
           database_name = EXCLUDED.database_name, installed_at = now(), registered_at = NULL, updated_at = now(),
           removed_at = NULL, purge_after = NULL, purged_at = NULL, backup_id = NULL`,
        [appId, manifest.version, manifest, wantsDatabase ? database : null],
      );
      await c.query("UPDATE app_credentials SET revoked_at = now() WHERE app_id = $1 AND revoked_at IS NULL", [appId]);
      await c.query("INSERT INTO app_credentials (key_id, app_id, scheme, verifier) VALUES ($1, $2, $3, $4)", [
        credential.keyId,
        appId,
        credential.scheme,
        credential.verifier,
      ]);
      // A re-install (after removal) keeps no schema of a type the new manifest doesn't publish.
      const removedSchemas = await pruneEventSchemas(c, appId, manifest);
      await audit(c, actor, "app.installed", appId, {
        version: manifest.version,
        ...(removedSchemas.length ? { removedEventSchemas: removedSchemas } : {}),
        database,
        role: roleResult,
        db: dbResult,
        keyId: credential.keyId,
        ...events,
      });
      return events;
    });

    deps.onLifecycleChange?.();
    const h = deps.appDatabaseHost;
    return {
      appId,
      state: "installed" as AppState,
      credential: credential.secret,
      keyId: credential.keyId,
      database: wantsDatabase
        ? { name: database, role, url: `postgres://${role}:${dbPassword}@${h.host}:${h.port}/${database}` }
        : null,
      events,
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
      // An upgrade can start publishing or subscribing, or drop a subscription or a published type:
      // the same idempotent stream and consumer steps as install, plus deleting the consumers of
      // dropped subscriptions and other apps' consumers of dropped published types, before anything is
      // written (a bus failure → 503, the transaction rolls back, the app registers again).
      const installed = await lockAndReadInstalled(c, appId, lockTimeoutMs);
      const previous = (
        await c.query<{ manifest: AppManifest | null }>("SELECT manifest FROM apps WHERE id = $1 FOR UPDATE", [appId])
      ).rows[0]?.manifest;
      const plan = planEventPlumbing({ appId, manifest: m, previous, installed });
      const events = await runEventPlumbing(deps.bus, appId, plan, waitingForPublisher(appId, m, installed));

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

      // A type this upgrade stops publishing leaves the event catalog with its schema.
      const removedSchemas = await pruneEventSchemas(c, appId, m);

      await audit(c, `app:${appId}`, "app.registered", appId, {
        version: m.version,
        ...(removedSchemas.length ? { removedEventSchemas: removedSchemas } : {}),
        permissions: perms,
        roles,
        ...events,
      });
      // Registration never changes the state and never writes role_grants.
      return { appId, version: m.version, state, permissions: perms, roles, events };
    });
  }

  /**
   * The app's signed upload of its event schemas (P4.2): `PUT /registry/v1/apps/<id>/event-schemas`,
   * body `{ "schemas": { "<type>": <JSON Schema> } }`, signed exactly like registration. The keys
   * must be exactly the types the app's CURRENT manifest publishes (see event-schemas.ts). Replaces
   * the app's whole set in one transaction; audited without the schema bodies.
   */
  async function uploadEventSchemas(appId: string, headers: Record<string, string | undefined>, body: string) {
    const path = `/registry/v1/apps/${appId}/event-schemas`;
    await authenticate(appId, "PUT", path, headers, body);
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      throw new ApiError("bad_request", "the body must be JSON");
    }
    return inTx(async (c) => {
      // Locked, so a registration that changes what the app publishes can't interleave with this upload.
      const row = (
        await c.query<{ state: AppState; version: string; manifest: AppManifest | null }>(
          "SELECT state, version, manifest FROM apps WHERE id = $1 FOR UPDATE",
          [appId],
        )
      ).rows[0];
      if (!row || row.state === "removed") throw new ApiError("unknown_app");
      const schemas = checkEventSchemas(row.manifest, input);
      const types = Object.keys(schemas);
      await c.query("DELETE FROM event_schemas WHERE app_id = $1", [appId]);
      for (const type of types) {
        await c.query(
          "INSERT INTO event_schemas (app_id, event_type, schema, app_version, updated_at) VALUES ($1, $2, $3, $4, now())",
          [appId, type, JSON.stringify(schemas[type]), row.version],
        );
      }
      await audit(c, `app:${appId}`, "event_schemas.updated", appId, { version: row.version, types });
      return { appId, version: row.version, types };
    });
  }

  const TRANSITIONS: Record<"activate" | "deactivate", { from: AppState[]; to: AppState }> = {
    activate: { from: ["installed", "inactive"], to: "active" },
    deactivate: { from: ["active"], to: "inactive" },
  };

  /** Admin: activate / deactivate. Gateway and launcher effects arrive in P3.3. */
  async function transition(appId: string, action: "activate" | "deactivate", actor: string) {
    const t = TRANSITIONS[action];
    if (appId === BUILT_IN_APP) throw new ApiError("invalid_state", `"${appId}" is built in and always active`);
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

  /** A backup as the API and the audit log show it. */
  const backupSummary = (id: number, database: string, f: BackupFile, createdAt: Date) => ({
    id,
    database,
    path: f.path,
    sizeBytes: f.sizeBytes,
    sha256: f.sha256,
    createdAt: createdAt.toISOString(),
  });

  /** Let a role log in again after a Remove that didn't go through. Best effort: the error being reported matters more. */
  async function unlockRole(role: string) {
    try {
      const prov = await deps.provisioner();
      try {
        await setRoleLogin(prov, role, true);
      } finally {
        await prov.end();
      }
    } catch {
      // The Remove's own error is what the admin sees; a retry locks and unlocks the role again.
    }
  }

  /**
   * Remove's backup of the app's database: stop its role logging in and end its sessions (so nothing
   * changes the data after the dump, and the backup is the database's final state), then dump it.
   * `undo` records what to put back if the Remove doesn't go through. Any failure → `backup_failed`.
   */
  async function backupForRemoval(
    appId: string,
    database: string,
    undo: { role?: string; file?: string },
  ): Promise<BackupFile> {
    const why = (err: unknown) =>
      new ApiError(
        "backup_failed",
        `${appId}'s database couldn't be backed up, so nothing was removed: ${(err as Error).message}`,
      );
    if (!deps.backups) throw why(new Error("no backup location is configured"));
    const { role } = appDatabaseNames(appId);
    try {
      const prov = await deps.provisioner();
      try {
        await setRoleLogin(prov, role, false);
        undo.role = role;
        await terminateConnections(prov, database);
      } finally {
        await prov.end();
      }
    } catch (err) {
      throw why(err);
    }
    try {
      const file = await deps.backups.dump(appId, database);
      undo.file = file.path;
      return file;
    } catch (err) {
      throw why(err);
    }
  }

  /**
   * Admin: remove an app (ADR 0001 §3 step 6). Only from `installed` or `inactive` (deactivate an
   * active one first); never the built-in app. Like install: the plumbing lock, the plan, then
   * the steps outside the core database, then the writes, all in one transaction:
   *
   *  1. the app's database, if it has one, is backed up (`backupForRemoval`: its role stops logging in,
   *     its sessions end, `pg_dump`); a failure → `backup_failed`;
   *  2. the bus (its own consumers, the other apps' consumers on its stream, its stream); a failure →
   *     `bus_unavailable`.
   *
   * Either failure leaves everything as it was: the transaction rolls back, the backup file is
   * deleted and the role may log in again. The dump runs under the plumbing lock, so an install or
   * registration that arrives meanwhile waits (at most `plumbingLockTimeoutMs`, then `registry_busy`).
   *
   * The writes: state `removed`, `removed_at`, and with a backup its row in `app_backups`, `backup_id`
   * and `purge_after` (removed_at + `retentionDays`); every credential revoked (it can't register,
   * upload schemas, get a token or connect to the bus); its event subscriptions and schemas deleted;
   * the grants of its roles deleted, its roles and permissions deprecated (the rows stay for their
   * foreign keys; a reinstall + registration restores them, as an upgrade does, with no grant carried
   * over). The database itself is kept until `purge`. Its OIDC client is not touched here.
   */
  async function remove(appId: string, actor: string) {
    if (appId === BUILT_IN_APP) throw new ApiError("invalid_state", `"${appId}" is built in and can't be removed`);
    const undo: { role?: string; file?: string } = {};
    const out = await inTx(async (c) => {
      const installed = await lockAndReadInstalled(c, appId, lockTimeoutMs);
      const row = (
        await c.query<{ state: AppState; manifest: AppManifest | null; database_name: string | null }>(
          "SELECT state, manifest, database_name FROM apps WHERE id = $1 FOR UPDATE",
          [appId],
        )
      ).rows[0];
      if (!row) throw new ApiError("not_found", `no app "${appId}"`);
      if (row.state !== "installed" && row.state !== "inactive") {
        throw new ApiError(
          "invalid_state",
          row.state === "active"
            ? "can't remove an active app: deactivate it first"
            : `can't remove an app that is ${row.state}`,
        );
      }
      const file = row.database_name ? await backupForRemoval(appId, row.database_name, undo) : null;
      const events = await runRemoval(deps.bus, appId, planRemoval({ appId, manifest: row.manifest, installed }));

      const removedAt = now();
      let backup: ReturnType<typeof backupSummary> | null = null;
      if (file && row.database_name) {
        const id = (
          await c.query<{ id: string }>(
            `INSERT INTO app_backups (app_id, database_name, path, size_bytes, sha256, created_at)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [appId, row.database_name, file.path, file.sizeBytes, file.sha256, removedAt],
          )
        ).rows[0]!.id;
        backup = backupSummary(Number(id), row.database_name, file, removedAt);
      }
      const purgeAt = backup ? purgeAfter(removedAt, deps.retentionDays ?? DEFAULT_RETENTION_DAYS) : null;
      await c.query(
        `UPDATE apps SET state = 'removed', removed_at = $2, purge_after = $3, purged_at = NULL, backup_id = $4,
             updated_at = now() WHERE id = $1`,
        [appId, removedAt, purgeAt, backup?.id ?? null],
      );
      const credentials = await c.query(
        "UPDATE app_credentials SET revoked_at = now() WHERE app_id = $1 AND revoked_at IS NULL",
        [appId],
      );
      await c.query("DELETE FROM event_subscriptions WHERE app_id = $1", [appId]);
      const schemas = await c.query<{ event_type: string }>(
        "DELETE FROM event_schemas WHERE app_id = $1 RETURNING event_type",
        [appId],
      );
      const grants = await c.query<{ role_key: string; subject: string }>(
        `DELETE FROM role_grants g USING roles r WHERE r.key = g.role_key AND r.app_id = $1
           RETURNING g.role_key, g.subject`,
        [appId],
      );
      await c.query(
        "UPDATE roles SET deprecated_at = now(), updated_at = now() WHERE app_id = $1 AND deprecated_at IS NULL",
        [appId],
      );
      await c.query(
        "UPDATE permissions SET deprecated_at = now(), updated_at = now() WHERE app_id = $1 AND deprecated_at IS NULL",
        [appId],
      );
      const detail = {
        from: row.state,
        revokedCredentials: credentials.rowCount ?? 0,
        removedGrants: grants.rows
          .map((g) => ({ role: g.role_key, subject: g.subject }))
          .sort((a, b) => a.role.localeCompare(b.role) || a.subject.localeCompare(b.subject)),
        removedEventSchemas: schemas.rows.map((x) => x.event_type).sort(),
        removedAt: removedAt.toISOString(),
        backup,
        purgeAfter: purgeAt?.toISOString() ?? null,
        ...events,
      };
      await audit(c, actor, "app.removed", appId, detail);
      return { appId, state: "removed" as AppState, previous: row.state, ...detail };
    }).catch(async (err: unknown) => {
      // Nothing was removed: no backup file without its row, and the app's role logs in again.
      if (undo.file) await deps.backups?.discard(undo.file);
      if (undo.role) await unlockRole(undo.role);
      throw err;
    });
    deps.onLifecycleChange?.(); // the gateway stops serving it from this moment
    return out;
  }

  /**
   * Admin: purge a removed app (ADR 0001 §3 step 6): drop its database and its login role. Refused
   * (`purge_refused`, `details.reason`) unless
   *
   *  - the retention window is over (`purge_after` has passed: `retention`), or `force` is set with
   *    `confirm` = the app id typed (the same typed-id check as the console's Remove);
   *  - the backup Remove took is recorded (`no_backup`);
   *  - its file is still there (`backup_missing`) with the recorded sha256 (`backup_mismatch`).
   *
   * Only a removed app that has a database and hasn't been purged (`invalid_state` otherwise). The
   * drop is idempotent (`absent`), so a purge that failed halfway can be run again. Audited as
   * `app.purged`. The backup file and its row are kept: they are the only copy of the data now.
   */
  async function purge(appId: string, actor: string, opts: { force?: boolean; confirm?: unknown } = {}) {
    if (appId === BUILT_IN_APP) throw new ApiError("invalid_state", `"${appId}" is built in and can't be purged`);
    if (opts.force && opts.confirm !== appId) {
      throw new ApiError("bad_request", `a forced purge needs "confirm": "${appId}" (the app id, typed)`);
    }
    return inTx(async (c) => {
      const row = (
        await c.query<{
          state: AppState;
          database_name: string | null;
          removed_at: Date | null;
          purge_after: Date | null;
          purged_at: Date | null;
          backup_id: string | null;
        }>(
          "SELECT state, database_name, removed_at, purge_after, purged_at, backup_id FROM apps WHERE id = $1 FOR UPDATE",
          [appId],
        )
      ).rows[0];
      if (!row) throw new ApiError("not_found", `no app "${appId}"`);
      if (row.state !== "removed")
        throw new ApiError("invalid_state", `can't purge an app that is ${row.state}: remove it first`);
      if (row.purged_at) throw new ApiError("invalid_state", `${appId} was already purged`);
      if (!row.database_name) throw new ApiError("invalid_state", `${appId} has no database to purge`);
      const database = row.database_name;

      const b = row.backup_id
        ? (
            await c.query<{ id: string; path: string; size_bytes: string; sha256: string; created_at: Date }>(
              "SELECT id, path, size_bytes, sha256, created_at FROM app_backups WHERE id = $1 AND app_id = $2",
              [row.backup_id, appId],
            )
          ).rows[0]
        : undefined;
      if (!b) {
        throw new ApiError("purge_refused", `${appId} has no recorded backup: its database is kept`, {
          reason: "no_backup",
        });
      }
      const at = now();
      const due = row.purge_after !== null && at.getTime() >= row.purge_after.getTime();
      if (!due && !opts.force) {
        throw new ApiError(
          "purge_refused",
          `${appId}'s retention window isn't over: it may be purged from ${row.purge_after?.toISOString() ?? "(never set)"}`,
          { reason: "retention", purgeAfter: row.purge_after?.toISOString() ?? null },
        );
      }
      const backup = backupSummary(
        Number(b.id),
        database,
        { path: b.path, sizeBytes: Number(b.size_bytes), sha256: b.sha256 },
        new Date(b.created_at),
      );
      const check = deps.backups ? await deps.backups.check(b.path, b.sha256) : "missing";
      if (check !== "ok") {
        throw new ApiError(
          "purge_refused",
          check === "missing"
            ? `${appId}'s backup ${b.path} isn't there any more: its database is kept`
            : `${appId}'s backup ${b.path} doesn't match its recorded sha256: its database is kept`,
          { reason: check === "missing" ? "backup_missing" : "backup_mismatch", backup },
        );
      }

      const { role } = appDatabaseNames(appId);
      const prov = await deps.provisioner();
      let dropped: Awaited<ReturnType<typeof dropDatabaseAndRole>>;
      try {
        dropped = await dropDatabaseAndRole(prov, database, role);
      } finally {
        await prov.end();
      }
      await c.query("UPDATE apps SET purged_at = $2, updated_at = now() WHERE id = $1", [appId, at]);
      const detail = {
        database: { name: database, result: dropped.database },
        role: { name: role, result: dropped.role },
        backup,
        removedAt: row.removed_at?.toISOString() ?? null,
        purgeAfter: row.purge_after?.toISOString() ?? null,
        purgedAt: at.toISOString(),
        forced: !due,
      };
      await audit(c, actor, "app.purged", appId, detail);
      return { appId, state: "removed" as AppState, ...detail };
    });
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
    const { roles, permissions } = await grantsOf(appId, subject);
    const { token, claims } = signAccessToken({
      key: deps.tokenKey,
      subject,
      audience: appId,
      roles,
      permissions,
      ttlSeconds: deps.accessTokenTtlSeconds,
      now: now(),
    });
    return { token, expiresAt: new Date(claims.exp * 1000).toISOString(), expiresIn: claims.exp - claims.iat };
  }

  /**
   * The app asks (signed GET, bound to this person's path) which apps its signed-in person can open:
   * active apps where they hold at least one role, plus public ones. See launcher.ts.
   */
  async function launcher(
    appId: string,
    subject: string,
    headers: Record<string, string | undefined>,
    path = `/registry/v1/apps/${appId}/launcher/${encodeURIComponent(subject)}`,
  ) {
    await authenticate(appId, "GET", path, headers, "");
    const apps = (
      await deps.pool.query<LauncherApp>("SELECT id, state, manifest FROM apps WHERE state = 'active' ORDER BY id")
    ).rows;
    const held = new Set(
      (
        await deps.pool.query<{ app_id: string }>(
          `SELECT DISTINCT r.app_id FROM role_grants g JOIN roles r ON r.key = g.role_key
            WHERE g.subject = $1 AND r.deprecated_at IS NULL`,
          [subject],
        )
      ).rows.map((r) => r.app_id),
    );
    return { subject, apps: launcherFor(apps, held, { urlTemplate: deps.appUrlTemplate }) };
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

  return {
    install,
    register,
    uploadEventSchemas,
    transition,
    remove,
    purge,
    get,
    pruneNonces,
    subjectAccess,
    issueAccessToken,
    launcher,
    grantRole,
    revokeRole,
  };
}

export type Registry = ReturnType<typeof createRegistry>;
