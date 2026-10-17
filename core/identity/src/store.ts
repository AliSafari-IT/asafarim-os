/**
 * The identity service's own database (migrations/): principals, their
 * identities (how they prove who they are), their connection (whether they
 * may use ASafariM), connection requests and the audit trail.
 *
 * Authentication and authorization stay separate here on purpose:
 * `verifiedLogin` records that someone proved a number and returns their
 * principal, and grants nothing; `principal(...).connection === "active"` is
 * the one authorization check, read fresh on every use, so a revocation takes
 * effect at the next request.
 */
import pg from "pg";
import type { Account, AccountStore } from "./accounts.ts";
import { migrate } from "./migrate.ts";

export type ConnectionStatus = "active" | "revoked" | "none";

export interface Principal {
  id: string;
  isAdmin: boolean;
  connection: ConnectionStatus;
  /** How the principal is shown: its email, else its phone number; null if it has neither. */
  label: string | null;
}

export interface ConnectionRequestRow {
  id: string;
  principalId: string;
  label: string | null;
  createdAt: Date;
}

export interface ConnectionRow {
  principalId: string;
  label: string | null;
  status: "active" | "revoked";
  isAdmin: boolean;
  grantedAt: Date;
  revokedAt: Date | null;
  /** When the number was last proved by a sign-in code; null if never. */
  lastLoginAt: Date | null;
}

export type AuditEvent =
  | "otp.sent"
  | "otp.send_failed"
  | "otp.send_refused"
  | "otp.verify_failed"
  | "otp.verify_refused"
  | "otp.verified"
  | "login.granted"
  | "login.not_authorized"
  | "logout"
  | "request.created"
  | "request.approved"
  | "request.rejected"
  | "connection.added"
  | "connection.revoked"
  | "connection.bootstrapped"
  | "admin.denied"
  | "passkey.registered"
  | "passkey.removed"
  | "passkey.failed";

export interface AuditEntry {
  event: AuditEvent;
  method?: "sms" | "email" | "passkey";
  principalId?: string | null;
  actorId?: string | null;
  /** HMAC of the identifier (never the number itself), for attempts nobody has proved yet. */
  subjectHandle?: string | null;
  ipHandle?: string | null;
  /** Codes, counts and ids only. Never a code, a number or a token. */
  detail?: Record<string, string | number | boolean | null>;
}

export interface AuditRow {
  at: Date;
  event: string;
  principalId: string | null;
  actorId: string | null;
  label: string | null;
  detail: Record<string, unknown>;
}

export type RequestOutcome = "created" | "already_pending" | "already_connected";

export interface IdentityStore {
  /** Someone proved this identity (a phone in E.164, a lower-case email): their principal, created on first proof. Grants nothing. */
  verifiedLogin(method: IdentityMethod, identifier: string): Promise<string>;
  principal(id: string): Promise<Principal | null>;
  requestConnection(principalId: string): Promise<RequestOutcome>;
  hasPendingRequest(principalId: string): Promise<boolean>;
  pendingRequests(): Promise<ConnectionRequestRow[]>;
  connections(): Promise<ConnectionRow[]>;
  /** Approve or reject one pending request. Null if it isn't pending (already decided, unknown). */
  decideRequest(requestId: string, decision: "approved" | "rejected", actorId: string): Promise<string | null>;
  /** Revoke an active connection. False if there was none. */
  revoke(principalId: string, actorId: string): Promise<boolean>;
  /** Connect an identity (creating its principal if needed); closes its pending request as approved. */
  addConnection(method: IdentityMethod, identifier: string, actorId: string): Promise<string>;
  /**
   * The first admin, from IDENTITY_BOOTSTRAP_ADMIN_PHONE: acts ONLY when no admin has an active
   * connection (a fresh database, or a recovery after every admin lost access), then makes those identities
   * an admin with an active connection. Otherwise it changes nothing.
   */
  bootstrapAdmin(identities: readonly Identity[]): Promise<"bootstrapped" | "unchanged">;
  addPasskey(principalId: string, passkey: NewPasskeyRow): Promise<void>;
  passkey(credentialId: string): Promise<PasskeyRow | null>;
  passkeysOf(principalId: string): Promise<PasskeyRow[]>;
  /** After a sign-in: the new counter, and when it was used. */
  touchPasskey(credentialId: string, signCount: number): Promise<void>;
  removePasskey(principalId: string, credentialId: string): Promise<boolean>;
  audit(entry: AuditEntry): Promise<void>;
  recentAudit(limit: number): Promise<AuditRow[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export type IdentityMethod = "phone" | "email";

export interface Identity {
  method: IdentityMethod;
  identifier: string;
}

export interface NewPasskeyRow {
  credentialId: string;
  publicKey: Record<string, string>;
  alg: number;
  signCount: number;
  transports: string[];
  name: string;
}

export interface PasskeyRow extends NewPasskeyRow {
  principalId: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** The SQL for a principal's label: its email first, else its phone. `$col` is the principal id column. */
const labelOf = (col: string) =>
  `(SELECT identifier FROM identities i WHERE i.principal_id = ${col} ORDER BY (i.method = 'email') DESC, i.created_at LIMIT 1)`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

/** A pool or a client in a transaction. */
interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

async function inTransaction<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** The principal for an identity, created (unverified) if there is none. Call inside a transaction. */
async function principalFor(c: Queryable, method: IdentityMethod, identifier: string): Promise<string> {
  const found = await c.query<{ principal_id: string }>(
    "SELECT principal_id FROM identities WHERE method = $1 AND identifier = $2 FOR UPDATE",
    [method, identifier],
  );
  if (found.rows[0]) return found.rows[0].principal_id;
  const created = await c.query<{ id: string }>("INSERT INTO principals DEFAULT VALUES RETURNING id");
  const id = created.rows[0]!.id;
  const inserted = await c.query(
    `INSERT INTO identities (method, identifier, principal_id) VALUES ($1, $2, $3)
     ON CONFLICT (method, identifier) DO NOTHING`,
    [method, identifier, id],
  );
  if (inserted.rowCount === 1) return id;
  // A concurrent first sign-in for the same number won the race: use its principal.
  await c.query("DELETE FROM principals WHERE id = $1", [id]);
  const again = await c.query<{ principal_id: string }>(
    "SELECT principal_id FROM identities WHERE method = $1 AND identifier = $2",
    [method, identifier],
  );
  return again.rows[0]!.principal_id;
}

async function writeAudit(c: Queryable, e: AuditEntry): Promise<void> {
  await c.query(
    `INSERT INTO audit_log (event, method, principal_id, actor_id, subject_handle, ip_handle, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      e.event,
      e.method ?? null,
      e.principalId ?? null,
      e.actorId ?? null,
      e.subjectHandle ?? null,
      e.ipHandle ?? null,
      JSON.stringify(e.detail ?? {}),
    ],
  );
}

export class PgIdentityStore implements IdentityStore {
  private readonly pool: pg.Pool;

  /**
   * `onIdleError`: an idle connection failed (the database restarted, a network cut). pg drops that
   * connection and the next query opens a new one; without a listener the pool's `error` event
   * would crash the process.
   */
  constructor(connectionString: string, onIdleError: (err: Error) => void = () => undefined) {
    this.pool = new pg.Pool({ connectionString, max: 6, idleTimeoutMillis: 30_000 });
    this.pool.on("error", onIdleError);
  }

  migrate(): Promise<string[]> {
    return migrate(this.pool);
  }

  async verifiedLogin(method: IdentityMethod, identifier: string): Promise<string> {
    return inTransaction(this.pool, async (c) => {
      const id = await principalFor(c, method, identifier);
      await c.query(
        `UPDATE identities SET verified_at = coalesce(verified_at, now()), last_login_at = now()
         WHERE method = $1 AND identifier = $2`,
        [method, identifier],
      );
      return id;
    });
  }

  async principal(id: string): Promise<Principal | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query<{
      id: string;
      is_admin: boolean;
      status: "active" | "revoked" | null;
      label: string | null;
    }>(
      `SELECT p.id, p.is_admin, c.status, ${labelOf("p.id")} AS label
       FROM principals p LEFT JOIN connections c ON c.principal_id = p.id
       WHERE p.id = $1`,
      [id],
    );
    const r = rows[0];
    return r ? { id: r.id, isAdmin: r.is_admin, connection: r.status ?? "none", label: r.label } : null;
  }

  async requestConnection(principalId: string): Promise<RequestOutcome> {
    return inTransaction(this.pool, async (c) => {
      // Serialise per principal: lock the principal row.
      await c.query("SELECT id FROM principals WHERE id = $1 FOR UPDATE", [principalId]);
      const conn = await c.query<{ status: string }>("SELECT status FROM connections WHERE principal_id = $1", [
        principalId,
      ]);
      if (conn.rows[0]?.status === "active") return "already_connected";
      const inserted = await c.query(
        `INSERT INTO connection_requests (principal_id) VALUES ($1)
         ON CONFLICT (principal_id) WHERE status = 'pending' DO NOTHING`,
        [principalId],
      );
      return inserted.rowCount === 1 ? "created" : "already_pending";
    });
  }

  async hasPendingRequest(principalId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "SELECT 1 FROM connection_requests WHERE principal_id = $1 AND status = 'pending'",
      [principalId],
    );
    return (rowCount ?? 0) > 0;
  }

  async pendingRequests(): Promise<ConnectionRequestRow[]> {
    const { rows } = await this.pool.query<{
      id: string;
      principal_id: string;
      label: string | null;
      created_at: Date;
    }>(
      `SELECT r.id, r.principal_id, r.created_at, ${labelOf("r.principal_id")} AS label
       FROM connection_requests r WHERE r.status = 'pending' ORDER BY r.created_at`,
    );
    return rows.map((r) => ({ id: r.id, principalId: r.principal_id, label: r.label, createdAt: r.created_at }));
  }

  async connections(): Promise<ConnectionRow[]> {
    const { rows } = await this.pool.query<{
      principal_id: string;
      label: string | null;
      status: "active" | "revoked";
      is_admin: boolean;
      granted_at: Date;
      revoked_at: Date | null;
      last_login_at: Date | null;
    }>(
      `SELECT c.principal_id, c.status, c.granted_at, c.revoked_at, p.is_admin, i.identifier AS label, i.last_login_at
       FROM connections c
       JOIN principals p ON p.id = c.principal_id
       LEFT JOIN LATERAL (
         SELECT identifier, last_login_at FROM identities
         WHERE principal_id = c.principal_id ORDER BY (method = 'email') DESC, created_at LIMIT 1
       ) i ON true
       ORDER BY c.status, c.granted_at`,
    );
    return rows.map((r) => ({
      principalId: r.principal_id,
      label: r.label,
      status: r.status,
      isAdmin: r.is_admin,
      grantedAt: r.granted_at,
      revokedAt: r.revoked_at,
      lastLoginAt: r.last_login_at,
    }));
  }

  async decideRequest(requestId: string, decision: "approved" | "rejected", actorId: string): Promise<string | null> {
    if (!isUuid(requestId)) return null;
    return inTransaction(this.pool, async (c) => {
      const decided = await c.query<{ principal_id: string }>(
        `UPDATE connection_requests SET status = $2, decided_at = now(), decided_by = $3
         WHERE id = $1 AND status = 'pending' RETURNING principal_id`,
        [requestId, decision, actorId],
      );
      const principalId = decided.rows[0]?.principal_id;
      if (!principalId) return null;
      if (decision === "approved") await grant(c, principalId, actorId);
      await writeAudit(c, {
        event: decision === "approved" ? "request.approved" : "request.rejected",
        principalId,
        actorId,
        detail: { requestId },
      });
      return principalId;
    });
  }

  async revoke(principalId: string, actorId: string): Promise<boolean> {
    if (!isUuid(principalId)) return false;
    return inTransaction(this.pool, async (c) => {
      const { rowCount } = await c.query(
        `UPDATE connections SET status = 'revoked', revoked_at = now(), revoked_by = $2
         WHERE principal_id = $1 AND status = 'active'`,
        [principalId, actorId],
      );
      if (!rowCount) return false;
      await writeAudit(c, { event: "connection.revoked", principalId, actorId });
      return true;
    });
  }

  async addConnection(method: IdentityMethod, identifier: string, actorId: string): Promise<string> {
    return inTransaction(this.pool, async (c) => {
      const principalId = await principalFor(c, method, identifier);
      await grant(c, principalId, actorId);
      await c.query(
        `UPDATE connection_requests SET status = 'approved', decided_at = now(), decided_by = $2
         WHERE principal_id = $1 AND status = 'pending'`,
        [principalId, actorId],
      );
      await writeAudit(c, { event: "connection.added", principalId, actorId });
      return principalId;
    });
  }

  async bootstrapAdmin(identities: readonly Identity[]): Promise<"bootstrapped" | "unchanged"> {
    const [first, ...more] = identities;
    if (!first) return "unchanged";
    return inTransaction(this.pool, async (c) => {
      // Two instances starting together must not both act.
      await c.query("SELECT pg_advisory_xact_lock(7243102)");
      const admins = await c.query(
        `SELECT 1 FROM principals p JOIN connections c ON c.principal_id = p.id
         WHERE p.is_admin AND c.status = 'active' LIMIT 1`,
      );
      if (admins.rowCount) return "unchanged";
      const principalId = await principalFor(c, first.method, first.identifier);
      // Further identities join the same principal, unless they already belong to someone else.
      for (const extra of more) {
        await c.query(
          `INSERT INTO identities (method, identifier, principal_id) VALUES ($1, $2, $3)
           ON CONFLICT (method, identifier) DO NOTHING`,
          [extra.method, extra.identifier, principalId],
        );
      }
      await c.query("UPDATE principals SET is_admin = true WHERE id = $1", [principalId]);
      await grant(c, principalId, null);
      await writeAudit(c, { event: "connection.bootstrapped", principalId, detail: { admin: true } });
      return "bootstrapped";
    });
  }

  async addPasskey(principalId: string, k: NewPasskeyRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO passkeys (credential_id, principal_id, public_key, alg, sign_count, transports, name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [k.credentialId, principalId, JSON.stringify(k.publicKey), k.alg, k.signCount, k.transports, k.name],
    );
  }

  private static passkeyRow(r: {
    credential_id: string;
    principal_id: string;
    public_key: Record<string, string>;
    alg: number;
    sign_count: string | number;
    transports: string[];
    name: string;
    created_at: Date;
    last_used_at: Date | null;
  }): PasskeyRow {
    return {
      credentialId: r.credential_id,
      principalId: r.principal_id,
      publicKey: r.public_key,
      alg: r.alg,
      signCount: Number(r.sign_count),
      transports: r.transports,
      name: r.name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    };
  }

  async passkey(credentialId: string): Promise<PasskeyRow | null> {
    const { rows } = await this.pool.query("SELECT * FROM passkeys WHERE credential_id = $1", [credentialId]);
    return rows[0] ? PgIdentityStore.passkeyRow(rows[0]) : null;
  }

  async passkeysOf(principalId: string): Promise<PasskeyRow[]> {
    if (!isUuid(principalId)) return [];
    const { rows } = await this.pool.query("SELECT * FROM passkeys WHERE principal_id = $1 ORDER BY created_at", [
      principalId,
    ]);
    return rows.map((r) => PgIdentityStore.passkeyRow(r));
  }

  async touchPasskey(credentialId: string, signCount: number): Promise<void> {
    await this.pool.query("UPDATE passkeys SET sign_count = $2, last_used_at = now() WHERE credential_id = $1", [
      credentialId,
      signCount,
    ]);
  }

  async removePasskey(principalId: string, credentialId: string): Promise<boolean> {
    if (!isUuid(principalId)) return false;
    const { rowCount } = await this.pool.query("DELETE FROM passkeys WHERE principal_id = $1 AND credential_id = $2", [
      principalId,
      credentialId,
    ]);
    return (rowCount ?? 0) > 0;
  }

  async audit(entry: AuditEntry): Promise<void> {
    await writeAudit(this.pool, entry);
  }

  async recentAudit(limit: number): Promise<AuditRow[]> {
    const { rows } = await this.pool.query<{
      at: Date;
      event: string;
      principal_id: string | null;
      actor_id: string | null;
      label: string | null;
      detail: Record<string, unknown>;
    }>(
      `SELECT a.at, a.event, a.principal_id, a.actor_id, a.detail, ${labelOf("a.principal_id")} AS label
       FROM audit_log a ORDER BY a.at DESC, a.id DESC LIMIT $1`,
      [Math.max(1, Math.min(500, Math.trunc(limit)))],
    );
    return rows.map((r) => ({
      at: r.at,
      event: r.event,
      principalId: r.principal_id,
      actorId: r.actor_id,
      label: r.label,
      detail: r.detail,
    }));
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Make the connection active (new, or re-granted after a revocation). */
async function grant(c: Queryable, principalId: string, actorId: string | null): Promise<void> {
  await c.query(
    `INSERT INTO connections (principal_id, status, granted_by) VALUES ($1, 'active', $2)
     ON CONFLICT (principal_id) DO UPDATE
       SET status = 'active', granted_at = now(), granted_by = $2, revoked_at = NULL, revoked_by = NULL
       WHERE connections.status <> 'active'`,
    [principalId, actorId],
  );
}

/**
 * Accounts for oidc-provider when the SMS method is on: a principal is an
 * account only while its connection is active, so a revoked person gets no
 * new tokens and their refresh tokens stop working at once.
 */
export class PrincipalAccounts implements AccountStore {
  private readonly store: IdentityStore;

  constructor(store: IdentityStore) {
    this.store = store;
  }

  async find(sub: string): Promise<Account | null> {
    const p = await this.store.principal(sub);
    if (!p) return null;
    // The label is the principal's email (else its phone number): apps show it instead of the bare id.
    const email = p.label && p.label.includes("@") ? p.label : null;
    return {
      sub: p.id,
      email,
      name: p.label,
      picture: null,
      roles: p.isAdmin ? ["identity.admin"] : [],
      isActive: p.connection === "active",
    };
  }

  ping(): Promise<void> {
    return this.store.ping();
  }

  async close(): Promise<void> {
    // The store is closed by its owner (server.ts).
  }
}
