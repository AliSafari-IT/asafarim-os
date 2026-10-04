/**
 * Per-service databases and roles for local development (OS-D1, #26; the ADR
 * 0001 §6 pattern): one database and one owner login role per service,
 * `REVOKE CONNECT … FROM PUBLIC`, CONNECT only for the roles that need it.
 * Then each service's migrations and seed. Idempotent: run it as often as you
 * like (`pnpm dev` runs it every time).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { ROOT } from "./keys.mjs";

/** The services that own a database in dev. Add one entry per new service. */
export const SERVICES = [
  {
    database: "os_accounts",
    owner: { role: "os_accounts", passwordEnv: "OS_ACCOUNTS_PASSWORD" },
    // Read-only login roles of OTHER services that may connect.
    readers: [{ role: "identity_ro", passwordEnv: "IDENTITY_RO_PASSWORD" }],
    migrations: ["tools/dev-hub/sql/001_dev_accounts.sql"],
    seed: seedDevUsers,
  },
];

/** Synthetic users from tools/dev-hub/seed-users.json (upsert). */
async function seedDevUsers(client) {
  const { users } = JSON.parse(readFileSync(path.join(ROOT, "tools/dev-hub/seed-users.json"), "utf8"));
  for (const u of users) {
    await client.query(
      `INSERT INTO dev_users (id, email, name, image, is_active, roles) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, image = EXCLUDED.image,
         is_active = EXCLUDED.is_active, roles = EXCLUDED.roles`,
      [u.id, u.email, u.name, u.image, u.isActive, u.roles],
    );
  }
  return users.length;
}

/** Create the login role, or reset its password if it exists. */
async function ensureRole(admin, role, password) {
  const exists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount > 0;
  const { rows } = await admin.query(
    exists
      ? "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS sql"
      : "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS sql",
    [role, password],
  );
  await admin.query(rows[0].sql);
  return exists ? "updated" : "created";
}

async function ensureDatabase(admin, database, owner) {
  const exists = (await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database])).rowCount > 0;
  if (!exists) {
    const { rows } = await admin.query("SELECT format('CREATE DATABASE %I OWNER %I', $1::text, $2::text) AS sql", [
      database,
      owner,
    ]);
    await admin.query(rows[0].sql);
  }
  return exists ? "exists" : "created";
}

/** Run DDL whose identifiers are quoted server-side by format(%I). */
async function exec(client, template, ...idents) {
  const args = idents.map((_, i) => `$${i + 2}::text`).join(", ");
  const { rows } = await client.query(`SELECT format($1::text, ${args}) AS sql`, [template, ...idents]);
  await client.query(rows[0].sql);
}

/**
 * Bootstrap every service. `env` holds the passwords (from .dev/db.env).
 * Returns a short report per service.
 */
export async function bootstrap(env, { log = console.log } = {}) {
  const admin = new pg.Client({ connectionString: env.POSTGRES_ADMIN_URL });
  await admin.connect();
  const report = [];
  try {
    for (const svc of SERVICES) {
      const owner = await ensureRole(admin, svc.owner.role, env[svc.owner.passwordEnv]);
      const readers = [];
      for (const r of svc.readers) readers.push(`${r.role} ${await ensureRole(admin, r.role, env[r.passwordEnv])}`);
      const db = await ensureDatabase(admin, svc.database, svc.owner.role);
      await exec(admin, "REVOKE CONNECT ON DATABASE %I FROM PUBLIC", svc.database);
      for (const role of [svc.owner.role, ...svc.readers.map((r) => r.role)]) {
        await exec(admin, "GRANT CONNECT ON DATABASE %I TO %I", svc.database, role);
      }

      const url = new URL(env.POSTGRES_ADMIN_URL);
      url.username = svc.owner.role;
      url.password = env[svc.owner.passwordEnv];
      url.pathname = `/${svc.database}`;
      const client = new pg.Client({ connectionString: url.href });
      await client.connect();
      try {
        for (const file of svc.migrations) await client.query(readFileSync(path.join(ROOT, file), "utf8"));
        const seeded = svc.seed ? await svc.seed(client) : 0;
        const line = `${svc.database}: database ${db}, owner ${svc.owner.role} ${owner}, readers [${readers.join(", ")}], ${svc.migrations.length} migration(s), ${seeded} seeded`;
        log(`bootstrap: ${line}`);
        report.push(line);
      } finally {
        await client.end();
      }
    }
  } finally {
    await admin.end();
  }
  return report;
}

/** Parse a .env file (KEY=value, KEY='value', KEY="value", # comments). */
export function readEnvFile(file) {
  const env = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2];
    if (v.length >= 2 && (v[0] === "'" || v[0] === '"') && v.at(-1) === v[0]) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}
