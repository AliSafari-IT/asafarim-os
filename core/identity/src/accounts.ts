/**
 * Accounts (ADR 0002, A3): read from the platform database's
 * `identity_accounts_v` view (asafarim-platform P2.2) through a read-only login
 * role that can SELECT that view and nothing else.
 *
 * View contract (P2.2): id, email, name, image, isActive, roles (role keys).
 */
import pg from "pg";

/**
 * What the provider knows about an account and the access it has: the one contract both login methods fill
 * (local: connections + client_admissions; Hub: the platform's view, platform#892), and `decide` reads.
 * `sub` is the canonical, stable account id, never pairwise.
 */
export interface AccountAccess {
  sub: string;
  /** `suspended` and `deleted` get nothing, from any client. */
  state: "active" | "suspended" | "deleted";
  email: string | null;
  /**
   * True only with stored verification evidence for `email`; false when there is an email without evidence;
   * undefined when there is no email, or the source (Hub's view today) doesn't say, so no claim is made.
   */
  emailVerified?: boolean | undefined;
  name: string | null;
  picture: string | null;
  /** Identity roles only. Signup never grants one. */
  roles: string[];
  /** An admin- or operator-approved connection: every client. */
  globalAccess: boolean;
  /** Clients a per-client public admission covers. A single boolean can't express this and must not stand in for it. */
  admittedClients: string[];
}

export type Account = AccountAccess;

export interface AccountStore {
  find(sub: string): Promise<Account | null>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/**
 * One row of identity_accounts_v → an Account. The view only has `isActive` today, so Hub keeps today's meaning:
 * active = state active with global access, inactive = no access, no per-client admissions, nothing verified.
 */
export function accountFromRow(row: Record<string, unknown>): Account {
  const roles = row.roles;
  const active = row.isActive === true;
  return {
    sub: String(row.id),
    state: active ? "active" : "suspended",
    email: (row.email as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    picture: (row.image as string | null) ?? null,
    roles: Array.isArray(roles) ? roles.map(String) : [],
    globalAccess: active,
    admittedClients: [],
  };
}

export class PgAccountStore implements AccountStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 30_000,
      // Belt and braces: the role only has SELECT on the view, and every
      // session is read-only as well.
      options: "-c default_transaction_read_only=on",
    });
  }

  async find(sub: string): Promise<Account | null> {
    const { rows } = await this.pool.query(
      'SELECT id, email, name, image, "isActive", roles FROM identity_accounts_v WHERE id = $1',
      [sub],
    );
    return rows[0] ? accountFromRow(rows[0]) : null;
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
