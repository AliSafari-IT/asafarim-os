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
  /** How the principal is shown: its email, else its Google address, else its phone number; null if none. */
  label: string | null;
  /** How this principal can sign in (besides passkeys): its identity methods. */
  methods: IdentityMethod[];
  /** Clients a public admission (client_admissions) lets this person use. Says nothing about suspension: see admission.ts. */
  admittedClients: string[];
  /**
   * Is the email shown as `label` (when it is one) backed by stored proof? True only when an identity holding that
   * same address has `verified_at`: an email identity proved by a code, or a Google account Google verified it for.
   * An address an admin typed in is not verified.
   */
  emailVerified: boolean;
}

/** What `verifiedLogin` and `verifiedGoogleLogin` say. A conflict never leaves a second principal for one identifier. */
export type VerifiedResult =
  | {
      kind: "ok";
      principalId: string;
      /** A principal was made by this call. */
      created: boolean;
      /** Google only: the identity joined a principal that already held the address (Google being its authority). */
      linked?: boolean;
    }
  | { kind: "conflict"; reason: "identifier_taken" };

/** `suspended`: a revoked connection stops it. `global`: an admin-granted connection already covers every client. */
export type AdmitOutcome = "admitted" | "already" | "suspended" | "global" | "unknown";

/** What a person asked for: the apps (client ids) and an optional note for the admin. */
export interface RequestDetails {
  apps: string[];
  note: string | null;
  /** The language the request was made in (en, nl, fr, de), for the decision e-mail. */
  locale?: string | null;
}

export interface PendingRequest extends RequestDetails {
  id: string;
  createdAt: Date;
}

export interface ConnectionRequestRow extends RequestDetails {
  id: string;
  principalId: string;
  label: string | null;
  createdAt: Date;
  /** The requester's identity methods, so the admin sees how they proved who they are. */
  methods: IdentityMethod[];
  /** Already connected: the request is for more apps. */
  connected: boolean;
}

export interface ConnectionRow {
  principalId: string;
  label: string | null;
  /** `active` with no connection row: admitted to `clients` only (a public policy), not to everything. */
  status: "active" | "revoked";
  /** The clients a public admission covers (empty for an admin-granted connection with none). */
  clients: string[];
  /** True when this person's access is a global connection (admin-granted); false when only `clients`. */
  global: boolean;
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
  | "google.verified"
  | "google.failed"
  | "login.granted"
  | "login.not_authorized"
  | "logout"
  | "request.created"
  | "request.updated"
  | "request.approved"
  | "request.rejected"
  | "connection.added"
  | "connection.revoked"
  | "connection.bootstrapped"
  | "connection.admitted"
  | "admin.denied"
  | "passkey.registered"
  | "passkey.removed"
  | "passkey.failed";

export interface AuditEntry {
  event: AuditEvent;
  method?: "sms" | "email" | "passkey" | "google";
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

/** What the Admin console may filter identity's trail by (audit-api.ts). */
export interface AuditSearch {
  /** Exact events (`login.granted`) and kinds (`otp.`, every event starting with it): any of them matches. */
  events?: string[];
  method?: string;
  /** Events about this principal, or done by them. */
  principalId?: string;
  /** An ip or subject handle: every attempt from one address, or on one identifier nobody proved. */
  handle?: string;
  since?: Date;
  until?: Date;
  before?: number;
  limit?: number;
}

export interface AuditSearchRow {
  id: number;
  at: Date;
  event: string;
  method: string | null;
  principalId: string | null;
  actorId: string | null;
  label: string | null;
  actorLabel: string | null;
  subjectHandle: string | null;
  ipHandle: string | null;
  detail: Record<string, unknown>;
}

export interface AuditCounts {
  perDay: { day: string; event: string; n: number }[];
  pendingRequests: number;
  /** Admin-granted (global) connections only: a public admission is not one. */
  activeConnections: number;
  /** People admitted to at least one client by a public policy. */
  publicAdmissions: number;
}

/** `updated`: a pending request's apps or note changed. `already_connected`: connected, and no apps asked for. */
export type RequestOutcome = "created" | "updated" | "already_pending" | "already_connected";

export interface IdentityStore {
  /** Someone proved this identity (a phone in E.164, a lower-case email): their principal, created on first proof. Grants nothing. */
  verifiedLogin(method: IdentityMethod, identifier: string): Promise<VerifiedResult>;
  /**
   * Google proved this account (its `sub`). Its principal, created on first proof. With `linkEmail` (Google is the
   * authority for that address), a first Google sign-in joins the principal that already holds the address, and
   * an address nobody holds yet becomes a verified email identity of the new principal. Grants nothing.
   */
  verifiedGoogleLogin(subject: string, email: string | null, linkEmail: boolean): Promise<VerifiedResult>;
  /**
   * The person proved an identifier at a client whose policy is `public`: admit them to THAT client, in one
   * transaction that locks the principal and re-reads its connection. A suspended person is never admitted; a
   * person with a global connection needs no row. Writes `connection.admitted` only when a row was really added.
   * Callers decide the policy from the server-side client config, never from the request.
   */
  admitPublic(principalId: string, clientId: string): Promise<AdmitOutcome>;
  principal(id: string): Promise<Principal | null>;
  /**
   * Ask for access: opens a pending request, or updates the open one (apps are added, a note replaces the old
   * one). A connected person may ask for more apps; asking for nothing while connected is `already_connected`.
   */
  requestConnection(principalId: string, details?: RequestDetails): Promise<RequestOutcome>;
  pendingRequest(principalId: string): Promise<PendingRequest | null>;
  pendingRequests(): Promise<ConnectionRequestRow[]>;
  connections(): Promise<ConnectionRow[]>;
  /** Approve or reject one pending request. Null if it isn't pending (already decided, unknown). */
  decideRequest(requestId: string, decision: "approved" | "rejected", actorId: string): Promise<string | null>;
  /** Revoke an active connection. False if there was none. */
  revoke(principalId: string, actorId: string): Promise<boolean>;
  /** Make a revoked connection active again, by principal (whatever the way they sign in). False if not revoked. */
  reconnect(principalId: string, actorId: string): Promise<boolean>;
  /** The email addresses of admins with an active connection (for new-request notices). */
  adminEmails(): Promise<string[]>;
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

export type IdentityMethod = "phone" | "email" | "google";

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

/** Which identity labels a principal: an email identity, then a Google one (its address), then a phone. */
const LABEL_ORDER = `CASE method WHEN 'email' THEN 0 WHEN 'google' THEN 1 ELSE 2 END, created_at`;

/** The SQL for a principal's label (see LABEL_ORDER). `$col` is the principal id column. */
const labelOf = (col: string) =>
  `(SELECT CASE WHEN i.method = 'google' THEN i.email ELSE i.identifier END FROM identities i
    WHERE i.principal_id = ${col} AND (i.method <> 'google' OR i.email IS NOT NULL) ORDER BY ${LABEL_ORDER} LIMIT 1)`;

/** The SQL for a principal's identity methods, as a text[]. */
const methodsOf = (col: string) =>
  `(SELECT coalesce(array_agg(DISTINCT method), '{}') FROM identities WHERE principal_id = ${col})`;

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

/**
 * The principal for an identity, created (unverified) if there is none; null if a concurrent change left the
 * identifier in no state we can use (a conflict, reported as such). Call inside a transaction.
 */
async function principalFor(
  c: Queryable,
  method: IdentityMethod,
  identifier: string,
): Promise<{ id: string; created: boolean } | null> {
  const found = await c.query<{ principal_id: string }>(
    "SELECT principal_id FROM identities WHERE method = $1 AND identifier = $2 FOR UPDATE",
    [method, identifier],
  );
  if (found.rows[0]) return { id: found.rows[0].principal_id, created: false };
  const created = await c.query<{ id: string }>("INSERT INTO principals DEFAULT VALUES RETURNING id");
  const id = created.rows[0]!.id;
  const inserted = await c.query(
    `INSERT INTO identities (method, identifier, principal_id) VALUES ($1, $2, $3)
     ON CONFLICT (method, identifier) DO NOTHING`,
    [method, identifier, id],
  );
  if (inserted.rowCount === 1) return { id, created: true };
  // A concurrent first sign-in for the same number won the race: use its principal.
  await c.query("DELETE FROM principals WHERE id = $1", [id]);
  const again = await c.query<{ principal_id: string }>(
    "SELECT principal_id FROM identities WHERE method = $1 AND identifier = $2",
    [method, identifier],
  );
  return again.rows[0] ? { id: again.rows[0].principal_id, created: false } : null;
}

const CONFLICT: VerifiedResult = { kind: "conflict", reason: "identifier_taken" };

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

  async verifiedLogin(method: IdentityMethod, identifier: string): Promise<VerifiedResult> {
    return inTransaction(this.pool, async (c) => {
      const found = await principalFor(c, method, identifier);
      if (!found) return CONFLICT;
      await c.query(
        `UPDATE identities SET verified_at = coalesce(verified_at, now()), last_login_at = now()
         WHERE method = $1 AND identifier = $2`,
        [method, identifier],
      );
      return { kind: "ok", principalId: found.id, created: found.created };
    });
  }

  async verifiedGoogleLogin(subject: string, email: string | null, linkEmail: boolean): Promise<VerifiedResult> {
    return inTransaction(this.pool, async (c) => {
      const found = await c.query<{ principal_id: string }>(
        "SELECT principal_id FROM identities WHERE method = 'google' AND identifier = $1 FOR UPDATE",
        [subject],
      );
      let principalId = found.rows[0]?.principal_id;
      let created = false;
      let linked = false;
      let bare = false; // a principal made here with no identity yet
      if (!principalId) {
        // First Google sign-in for this account. Join the address's principal only when Google is its authority.
        if (linkEmail && email) {
          const joined = await principalFor(c, "email", email);
          if (!joined) return CONFLICT;
          principalId = joined.id;
          created = joined.created;
          linked = !joined.created;
        } else {
          principalId = (await c.query<{ id: string }>("INSERT INTO principals DEFAULT VALUES RETURNING id")).rows[0]!
            .id;
          created = true;
          bare = true;
        }
        const inserted = await c.query(
          `INSERT INTO identities (method, identifier, principal_id, email) VALUES ('google', $1, $2, $3)
           ON CONFLICT (method, identifier) DO NOTHING`,
          [subject, principalId, email],
        );
        if (inserted.rowCount !== 1) {
          // A concurrent first sign-in with the same Google account won the race: use its principal.
          const winner = (
            await c.query<{ principal_id: string }>(
              "SELECT principal_id FROM identities WHERE method = 'google' AND identifier = $1",
              [subject],
            )
          ).rows[0]?.principal_id;
          if (!winner) return CONFLICT;
          // A principal made above with no identity is unused: drop it so the race leaves exactly one.
          if (bare) await c.query("DELETE FROM principals WHERE id = $1", [principalId]);
          principalId = winner;
          created = false;
          linked = false;
        }
        if (linkEmail && email) {
          await c.query(
            `UPDATE identities SET verified_at = coalesce(verified_at, now())
             WHERE method = 'email' AND identifier = $1 AND principal_id = $2`,
            [email, principalId],
          );
        }
      }
      await c.query(
        `UPDATE identities SET email = $2, verified_at = coalesce(verified_at, now()), last_login_at = now()
         WHERE method = 'google' AND identifier = $1`,
        [subject, email],
      );
      return { kind: "ok", principalId, created, ...(linked ? { linked: true } : {}) };
    });
  }

  async principal(id: string): Promise<Principal | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query<{
      id: string;
      is_admin: boolean;
      status: "active" | "revoked" | null;
      label: string | null;
      methods: IdentityMethod[];
      admitted: string[];
      email_verified: boolean;
    }>(
      `SELECT p.id, p.is_admin, c.status, l.label, ${methodsOf("p.id")} AS methods,
              (SELECT coalesce(array_agg(a.client_id ORDER BY a.client_id), '{}') FROM client_admissions a
                WHERE a.principal_id = p.id) AS admitted,
              -- Verified only by stored proof, for the very address shown as the label.
              (position('@' in coalesce(l.label, '')) > 0 AND EXISTS (
                 SELECT 1 FROM identities i
                  WHERE i.principal_id = p.id AND i.verified_at IS NOT NULL
                    AND ((i.method = 'email' AND i.identifier = l.label) OR (i.method = 'google' AND i.email = l.label))
               )) AS email_verified
       FROM principals p
       LEFT JOIN connections c ON c.principal_id = p.id
       CROSS JOIN LATERAL (SELECT ${labelOf("p.id")} AS label) l
       WHERE p.id = $1`,
      [id],
    );
    const r = rows[0];
    return r
      ? {
          id: r.id,
          isAdmin: r.is_admin,
          connection: r.status ?? "none",
          label: r.label,
          methods: r.methods,
          admittedClients: r.admitted,
          emailVerified: r.email_verified,
        }
      : null;
  }

  async requestConnection(
    principalId: string,
    details: RequestDetails = { apps: [], note: null },
  ): Promise<RequestOutcome> {
    return inTransaction(this.pool, async (c) => {
      // Serialise per principal: lock the principal row.
      await c.query("SELECT id FROM principals WHERE id = $1 FOR UPDATE", [principalId]);
      const conn = await c.query<{ status: string }>("SELECT status FROM connections WHERE principal_id = $1", [
        principalId,
      ]);
      if (conn.rows[0]?.status === "active" && details.apps.length === 0) return "already_connected";
      const inserted = await c.query(
        `INSERT INTO connection_requests (principal_id, apps, note, locale) VALUES ($1, $2, $3, $4)
         ON CONFLICT (principal_id) WHERE status = 'pending' DO NOTHING`,
        [principalId, details.apps, details.note, details.locale ?? null],
      );
      if (inserted.rowCount === 1) return "created";
      const updated = await c.query(
        `UPDATE connection_requests
         SET apps = (SELECT coalesce(array_agg(DISTINCT a ORDER BY a), '{}') FROM unnest(apps || $2::text[]) a),
             note = coalesce($3, note),
             locale = coalesce($4, locale)
         WHERE principal_id = $1 AND status = 'pending'
           AND (NOT (apps @> $2::text[]) OR ($3::text IS NOT NULL AND note IS DISTINCT FROM $3))`,
        [principalId, details.apps, details.note, details.locale ?? null],
      );
      return updated.rowCount === 1 ? "updated" : "already_pending";
    });
  }

  async pendingRequest(principalId: string): Promise<PendingRequest | null> {
    if (!isUuid(principalId)) return null;
    const { rows } = await this.pool.query<{ id: string; apps: string[]; note: string | null; created_at: Date }>(
      "SELECT id, apps, note, created_at FROM connection_requests WHERE principal_id = $1 AND status = 'pending'",
      [principalId],
    );
    const r = rows[0];
    return r ? { id: r.id, apps: r.apps, note: r.note, createdAt: r.created_at } : null;
  }

  async pendingRequests(): Promise<ConnectionRequestRow[]> {
    const { rows } = await this.pool.query<{
      id: string;
      principal_id: string;
      label: string | null;
      created_at: Date;
      apps: string[];
      note: string | null;
      locale: string | null;
      methods: IdentityMethod[];
      connected: boolean;
    }>(
      `SELECT r.id, r.principal_id, r.created_at, r.apps, r.note, r.locale, ${labelOf("r.principal_id")} AS label,
              ${methodsOf("r.principal_id")} AS methods,
              EXISTS (SELECT 1 FROM connections c WHERE c.principal_id = r.principal_id AND c.status = 'active') AS connected
       FROM connection_requests r WHERE r.status = 'pending' ORDER BY r.created_at`,
    );
    return rows.map((r) => ({
      id: r.id,
      principalId: r.principal_id,
      label: r.label,
      createdAt: r.created_at,
      apps: r.apps,
      note: r.note,
      locale: r.locale,
      methods: r.methods,
      connected: r.connected,
    }));
  }

  async connections(): Promise<ConnectionRow[]> {
    // Everyone with a connection row, plus people who only hold a public admission (no row): the admin must be
    // able to find them to suspend them.
    const { rows } = await this.pool.query<{
      principal_id: string;
      label: string | null;
      status: "active" | "revoked";
      is_admin: boolean;
      granted_at: Date;
      revoked_at: Date | null;
      last_login_at: Date | null;
      clients: string[];
      is_global: boolean;
    }>(
      `SELECT p.id AS principal_id, p.is_admin,
              coalesce(c.status, 'active') AS status,
              coalesce(c.granted_at, (SELECT min(a.granted_at) FROM client_admissions a WHERE a.principal_id = p.id)) AS granted_at,
              c.revoked_at, i.identifier AS label, i.last_login_at,
              (SELECT coalesce(array_agg(a.client_id ORDER BY a.client_id), '{}') FROM client_admissions a
                WHERE a.principal_id = p.id) AS clients,
              (c.status = 'active' OR (c.status = 'revoked' AND c.source IS DISTINCT FROM 'suspension')) AS is_global
       FROM principals p
       LEFT JOIN connections c ON c.principal_id = p.id
       LEFT JOIN LATERAL (
         SELECT CASE WHEN method = 'google' THEN email ELSE identifier END AS identifier,
                (SELECT max(last_login_at) FROM identities WHERE principal_id = p.id) AS last_login_at
         FROM identities
         WHERE principal_id = p.id AND (method <> 'google' OR email IS NOT NULL)
         ORDER BY ${LABEL_ORDER} LIMIT 1
       ) i ON true
       WHERE c.principal_id IS NOT NULL OR EXISTS (SELECT 1 FROM client_admissions a WHERE a.principal_id = p.id)
       ORDER BY coalesce(c.status, 'active'), 4`,
    );
    return rows.map((r) => ({
      principalId: r.principal_id,
      label: r.label,
      status: r.status,
      clients: r.clients,
      global: r.is_global === true,
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
      if (decision === "approved") await grant(c, principalId, actorId, "admin");
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
      // Serialise with admitPublic and reconnect: suspension and admission can't interleave.
      await c.query("SELECT id FROM principals WHERE id = $1 FOR UPDATE", [principalId]);
      const { rowCount } = await c.query(
        `UPDATE connections SET status = 'revoked', revoked_at = now(), revoked_by = $2
         WHERE principal_id = $1 AND status = 'active'`,
        [principalId, actorId],
      );
      if (rowCount) {
        await writeAudit(c, { event: "connection.revoked", principalId, actorId });
        return true;
      }
      // No active connection. A person who holds public admissions and no connection row is suspended by a
      // revoked row of their own, marked so that reconnecting it restores their admissions and nothing more.
      const suspended = await c.query(
        `INSERT INTO connections (principal_id, status, revoked_at, revoked_by, source)
         SELECT $1, 'revoked', now(), $2, 'suspension'
          WHERE EXISTS (SELECT 1 FROM client_admissions WHERE principal_id = $1)
         ON CONFLICT (principal_id) DO NOTHING`,
        [principalId, actorId],
      );
      if (!suspended.rowCount) return false;
      await writeAudit(c, { event: "connection.revoked", principalId, actorId, detail: { admissionsOnly: true } });
      return true;
    });
  }

  async reconnect(principalId: string, actorId: string): Promise<boolean> {
    if (!isUuid(principalId)) return false;
    return inTransaction(this.pool, async (c) => {
      await c.query("SELECT id FROM principals WHERE id = $1 FOR UPDATE", [principalId]);
      const row = await c.query<{ source: string | null }>(
        "SELECT source FROM connections WHERE principal_id = $1 AND status = 'revoked' FOR UPDATE",
        [principalId],
      );
      if (!row.rowCount) return false;
      if (row.rows[0]!.source === "suspension") {
        // Lift the suspension: their admissions apply again. Never a global connection.
        await c.query("DELETE FROM connections WHERE principal_id = $1 AND status = 'revoked'", [principalId]);
        await writeAudit(c, {
          event: "connection.added",
          principalId,
          actorId,
          detail: { reconnect: true, admissionsOnly: true },
        });
        return true;
      }
      await grant(c, principalId, actorId, "admin");
      await writeAudit(c, { event: "connection.added", principalId, actorId, detail: { reconnect: true } });
      return true;
    });
  }

  async admitPublic(principalId: string, clientId: string): Promise<AdmitOutcome> {
    if (!isUuid(principalId)) return "unknown";
    return inTransaction(this.pool, async (c) => {
      // The same lock revoke() and reconnect() take: whoever comes second sees the first's result.
      const locked = await c.query("SELECT id FROM principals WHERE id = $1 FOR UPDATE", [principalId]);
      if (!locked.rowCount) return "unknown";
      const conn = await c.query<{ status: "active" | "revoked" }>(
        "SELECT status FROM connections WHERE principal_id = $1",
        [principalId],
      );
      const status = conn.rows[0]?.status;
      if (status === "revoked") return "suspended";
      if (status === "active") return "global";
      const inserted = await c.query(
        `INSERT INTO client_admissions (principal_id, client_id, source) VALUES ($1, $2, 'public_signup')
         ON CONFLICT (principal_id, client_id) DO NOTHING`,
        [principalId, clientId],
      );
      if (!inserted.rowCount) return "already";
      await writeAudit(c, {
        event: "connection.admitted",
        principalId,
        detail: { clientId, source: "public_signup" },
      });
      return "admitted";
    });
  }

  async adminEmails(): Promise<string[]> {
    const { rows } = await this.pool.query<{ email: string }>(
      `SELECT DISTINCT CASE WHEN i.method = 'google' THEN i.email ELSE i.identifier END AS email
       FROM principals p
       JOIN connections c ON c.principal_id = p.id AND c.status = 'active'
       JOIN identities i ON i.principal_id = p.id AND (i.method = 'email' OR (i.method = 'google' AND i.email IS NOT NULL))
       WHERE p.is_admin`,
    );
    return rows.map((r) => r.email);
  }

  async addConnection(method: IdentityMethod, identifier: string, actorId: string): Promise<string> {
    return inTransaction(this.pool, async (c) => {
      const found = await principalFor(c, method, identifier);
      if (!found) throw new Error("identifier_conflict");
      const principalId = found.id;
      await grant(c, principalId, actorId, "admin");
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
      const firstFound = await principalFor(c, first.method, first.identifier);
      if (!firstFound) throw new Error("identifier_conflict");
      const principalId = firstFound.id;
      // Further identities join the same principal, unless they already belong to someone else.
      for (const extra of more) {
        await c.query(
          `INSERT INTO identities (method, identifier, principal_id) VALUES ($1, $2, $3)
           ON CONFLICT (method, identifier) DO NOTHING`,
          [extra.method, extra.identifier, principalId],
        );
      }
      await c.query("UPDATE principals SET is_admin = true WHERE id = $1", [principalId]);
      await grant(c, principalId, null, "bootstrap");
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

  /** The Admin console's read of the trail (audit-api.ts): filtered, newest first, paged by id. */
  async searchAudit(f: AuditSearch): Promise<{ events: AuditSearchRow[]; next: number | null }> {
    const limit = Math.max(1, Math.min(200, Math.trunc(f.limit ?? 50)));
    const kinds = f.events?.filter((e) => e.endsWith(".")) ?? [];
    const exact = f.events?.filter((e) => !e.endsWith(".")) ?? [];
    const { rows } = await this.pool.query<{
      id: string;
      at: Date;
      event: string;
      method: string | null;
      principal_id: string | null;
      actor_id: string | null;
      subject_handle: string | null;
      ip_handle: string | null;
      detail: Record<string, unknown>;
      label: string | null;
      actor_label: string | null;
    }>(
      `SELECT a.id, a.at, a.event, a.method, a.principal_id, a.actor_id, a.subject_handle, a.ip_handle, a.detail,
              ${labelOf("a.principal_id")} AS label, ${labelOf("a.actor_id")} AS actor_label
         FROM audit_log a
        WHERE (cardinality($1::text[]) + cardinality($2::text[]) = 0
               OR a.event = ANY($1::text[])
               OR EXISTS (SELECT 1 FROM unnest($2::text[]) k WHERE left(a.event, length(k)) = k))
          AND ($3::text IS NULL OR a.method = $3)
          AND ($4::uuid IS NULL OR a.principal_id = $4 OR a.actor_id = $4)
          AND ($5::timestamptz IS NULL OR a.at >= $5)
          AND ($6::timestamptz IS NULL OR a.at < $6)
          AND ($7::bigint IS NULL OR a.id < $7)
          AND ($8::text IS NULL OR a.ip_handle = $8 OR a.subject_handle = $8)
        ORDER BY a.id DESC LIMIT $9`,
      [
        exact,
        kinds,
        f.method ?? null,
        f.principalId ?? null,
        f.since ?? null,
        f.until ?? null,
        f.before ?? null,
        f.handle ?? null,
        limit + 1,
      ],
    );
    const events = rows.slice(0, limit).map((r) => ({
      id: Number(r.id),
      at: r.at,
      event: r.event,
      method: r.method,
      principalId: r.principal_id,
      actorId: r.actor_id,
      label: r.label,
      actorLabel: r.actor_label,
      subjectHandle: r.subject_handle,
      ipHandle: r.ip_handle,
      detail: r.detail,
    }));
    return { events, next: rows.length > limit ? events[events.length - 1]!.id : null };
  }

  /** Counts for the Admin console's overview: per UTC day and event since `since`, and the open requests. */
  async auditCounts(since: Date): Promise<AuditCounts> {
    const [perDay, pending, active, admitted] = await Promise.all([
      this.pool.query<{ day: string; event: string; n: number }>(
        `SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, event, count(*)::int AS n
           FROM audit_log WHERE at >= $1 GROUP BY 1, 2`,
        [since],
      ),
      this.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM connection_requests WHERE status = 'pending'"),
      this.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM connections WHERE status = 'active'"),
      this.pool.query<{ n: number }>("SELECT count(DISTINCT principal_id)::int AS n FROM client_admissions"),
    ]);
    return {
      perDay: perDay.rows,
      pendingRequests: pending.rows[0]?.n ?? 0,
      activeConnections: active.rows[0]?.n ?? 0,
      publicAdmissions: admitted.rows[0]?.n ?? 0,
    };
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Make the connection active (new, or re-granted after a revocation). `source`: who granted it (connections.source). */
async function grant(
  c: Queryable,
  principalId: string,
  actorId: string | null,
  source: "admin" | "bootstrap",
): Promise<void> {
  await c.query(
    `INSERT INTO connections (principal_id, status, granted_by, source) VALUES ($1, 'active', $2, $3)
     ON CONFLICT (principal_id) DO UPDATE
       SET status = 'active', granted_at = now(), granted_by = $2, source = $3, revoked_at = NULL, revoked_by = NULL
       WHERE connections.status <> 'active'`,
    [principalId, actorId, source],
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
      // A global connection only. Per-client access and suspension travel separately: admission.ts decides.
      isActive: p.connection === "active",
      suspended: p.connection === "revoked",
      admittedClients: p.admittedClients,
      // Only with an email to speak of, and only from stored proof.
      emailVerified: email ? p.emailVerified : undefined,
    };
  }

  ping(): Promise<void> {
    return this.store.ping();
  }

  async close(): Promise<void> {
    // The store is closed by its owner (server.ts).
  }
}
