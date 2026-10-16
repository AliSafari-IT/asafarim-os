/**
 * One database and one owner login role per service or app (ADR 0001 §6):
 * `CREATE DATABASE … OWNER …`, `REVOKE CONNECT … FROM PUBLIC`, CONNECT only
 * for the roles that need it. Idempotent. Shared by the OS-D1 dev bootstrap
 * (scripts/dev/bootstrap.mjs) and app install.
 *
 * Remove and purge (ADR 0001 §3 step 6) use the helpers at the end: lock the role while its
 * database is backed up, then, after the retention window, drop the database and the role.
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

/** Let the role log in again, or stop it (Remove: nothing writes to the database after its backup). */
export async function setRoleLogin(client: Queryable, role: string, login: boolean): Promise<void> {
  await ddl(client, login ? "ALTER ROLE %I LOGIN" : "ALTER ROLE %I NOLOGIN", role);
}

/** End every session on the database but the caller's own. Returns how many were ended. */
export async function terminateConnections(client: Queryable, database: string): Promise<number> {
  const r = await client.query<{ ended: boolean }>(
    "SELECT pg_terminate_backend(pid) AS ended FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [database],
  );
  return r.rows.filter((x) => x.ended).length;
}

/**
 * Purge: drop the app's database (ending its sessions) and then its login role. Idempotent: what is
 * already gone is `absent`, so a purge that failed halfway can simply be run again.
 */
export async function dropDatabaseAndRole(
  client: Queryable,
  database: string,
  role: string,
): Promise<{ database: "dropped" | "absent"; role: "dropped" | "absent" }> {
  const dbExists = ((await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database])).rowCount ?? 0) > 0;
  if (dbExists) await ddl(client, "DROP DATABASE IF EXISTS %I WITH (FORCE)", database);
  const roleExists = ((await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount ?? 0) > 0;
  if (roleExists) await ddl(client, "DROP ROLE IF EXISTS %I", role);
  return { database: dbExists ? "dropped" : "absent", role: roleExists ? "dropped" : "absent" };
}
