/**
 * Accounts (ADR 0002, A3): read from the platform database's
 * `identity_accounts_v` view (asafarim-platform P2.2) through a read-only login
 * role that can SELECT that view and nothing else.
 *
 * View contract (P2.2): id, email, name, image, isActive, roles (role keys).
 */
import pg from "pg";

export interface Account {
  sub: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  roles: string[];
  isActive: boolean;
}

export interface AccountStore {
  find(sub: string): Promise<Account | null>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** One row of identity_accounts_v → an Account. */
export function accountFromRow(row: Record<string, unknown>): Account {
  const roles = row.roles;
  return {
    sub: String(row.id),
    email: (row.email as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    picture: (row.image as string | null) ?? null,
    roles: Array.isArray(roles) ? roles.map(String) : [],
    isActive: row.isActive === true,
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
