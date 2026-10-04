/**
 * One database and one owner login role per service or app (ADR 0001 §6):
 * `CREATE DATABASE … OWNER …`, `REVOKE CONNECT … FROM PUBLIC`, CONNECT only
 * for the roles that need it. Idempotent. Shared by the OS-D1 dev bootstrap
 * (scripts/dev/bootstrap.mjs) and app install.
 *
 * Every identifier and password goes through format(%I / %L) server-side.
 */
import type pg from "pg";

type Queryable = Pick<pg.Client, "query">;

async function ddl(client: Queryable, template: string, ...args: string[]) {
  const params = args.map((_, i) => `$${i + 2}::text`).join(", ");
  const { rows } = await client.query<{ sql: string }>(`SELECT format($1::text, ${params}) AS sql`, [
    template,
    ...args,
  ]);
  await client.query(rows[0]!.sql);
}

/** Create the login role, or set its password if it exists. */
export async function ensureRole(client: Queryable, role: string, password: string): Promise<"created" | "updated"> {
  const exists = ((await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount ?? 0) > 0;
  await ddl(client, exists ? "ALTER ROLE %I LOGIN PASSWORD %L" : "CREATE ROLE %I LOGIN PASSWORD %L", role, password);
  return exists ? "updated" : "created";
}

/** Create the database (owned by `owner`), lock it down, and grant CONNECT. */
export async function ensureDatabase(
  client: Queryable,
  database: string,
  owner: string,
  connectRoles: string[] = [],
): Promise<"created" | "exists"> {
  const exists = ((await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database])).rowCount ?? 0) > 0;
  if (!exists) await ddl(client, "CREATE DATABASE %I OWNER %I", database, owner);
  await ddl(client, "REVOKE CONNECT ON DATABASE %I FROM PUBLIC", database);
  for (const role of [owner, ...connectRoles]) await ddl(client, "GRANT CONNECT ON DATABASE %I TO %I", database, role);
  return exists ? "exists" : "created";
}

/** The database and role names for an app id (kebab-case → snake_case, prefixed). */
export function appDatabaseNames(appId: string): { database: string; role: string } {
  const name = `app_${appId.replace(/-/g, "_")}`;
  return { database: name, role: name };
}
