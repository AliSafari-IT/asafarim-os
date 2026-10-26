/**
 * Flow's own database (created by `platform app install`): workflows, their versions, runs and steps,
 * next to the event outbox (whose rows the relay sends to the bus) and the inbox (one row per event
 * consumed). On first use it runs the migrations and seeds the shipped workflows, once per process.
 */
import { startAppRelay, ulid, type Relay } from "@asafarim/app-sdk/events";
import { databaseNameOf, traceDatabasePool } from "@asafarim/telemetry";
import pg from "pg";
import manifest from "../platform.app";
import { writeAudit, type AuditEntry } from "./audit";
import { createEngine, type Engine } from "./engine/engine";
import { pgStore } from "./engine/pg-store";
import type { Tx } from "./engine/store";
import { publisher } from "./events";
import { log } from "./log";
import { migrate } from "./migrations";
import { manifestProblems, parseDefinition } from "./workflow/definition";
import { SEED_WORKFLOWS } from "./workflow/seed";

const globalForDb = globalThis as unknown as {
  flowPool?: pg.Pool;
  flowSchema?: Promise<void>;
  flowRelay?: Relay | null;
};

function pool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (run `pnpm platform app install flow --env-out .dev/flow.env`)");
  globalForDb.flowPool ??= createFlowPool(url);
  return globalForDb.flowPool;
}

/**
 * The app's pool. Each query inside a traced request is a CLIENT span: the operation, the database
 * name and, on failure, the SQLSTATE; never the SQL text or its parameters. Connecting is lazy.
 */
export function createFlowPool(url: string): pg.Pool {
  const p = traceDatabasePool(new pg.Pool({ connectionString: url, max: 5 }), { namespace: databaseNameOf(url) });
  // An idle connection dropped by the server is reported on the pool; unhandled, it would crash the process.
  p.on("error", (err) => log.warn("db.idle_connection_lost", { error: err.message }));
  return p;
}

/** Store version 1 of each shipped workflow, unless it is there already. A definition that doesn't validate stops the app. */
export async function seedWorkflows(tx: Tx): Promise<void> {
  for (const seed of SEED_WORKFLOWS) {
    const parsed = parseDefinition(seed.definition);
    if (!parsed.ok) throw new Error(`workflow ${seed.definition.key} is invalid: ${parsed.problems.join("; ")}`);
    const problems = manifestProblems(parsed.definition, manifest);
    if (problems.length) throw new Error(`workflow ${seed.definition.key}: ${problems.join("; ")}`);
    await tx.query("INSERT INTO workflows (id, key, name) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING", [
      ulid(),
      parsed.definition.key,
      seed.name,
    ]);
    await tx.query(
      `INSERT INTO workflow_versions (id, workflow_id, version, definition)
       SELECT $1, id, 1, $3 FROM workflows WHERE key = $2
       ON CONFLICT (workflow_id, version) DO NOTHING`,
      [ulid(), parsed.definition.key, JSON.stringify(parsed.definition)],
    );
  }
}

/** Migrate and seed `p` (idempotent; safe with several instances). */
export async function prepare(p: pg.Pool): Promise<void> {
  const client = await p.connect();
  try {
    const applied = await migrate(client);
    if (applied.length) log.info("db.migrated", { versions: applied });
    await client.query("BEGIN");
    await seedWorkflows(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** The pool, migrated and seeded (once per process; a failed run is retried on the next call). */
export async function db(): Promise<pg.Pool> {
  const p = pool();
  globalForDb.flowSchema ??= prepare(p).catch((err: unknown) => {
    globalForDb.flowSchema = undefined;
    throw err;
  });
  await globalForDb.flowSchema;
  return p;
}

/** `fn` in one transaction on `p`; its audit entries are written after COMMIT, never for a rollback. */
export async function inTransaction<T extends { audits: AuditEntry[] }>(
  p: pg.Pool,
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    writeAudit(result.audits);
    globalForDb.flowRelay?.wake();
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** The engine on this database: Postgres store, the manifest-checked publisher. */
export const engine: Engine = createEngine({
  store: pgStore,
  publish: (tx, type, data, subject) => publisher.publish(tx, type, data, { subject }),
  newId: () => ulid(),
  log,
});

/** Wake the relay after a commit that wrote to the outbox outside `inTransaction` (the subscribers). */
export function wakeRelay(): void {
  globalForDb.flowRelay?.wake();
}

/**
 * Start the outbox relay once per process (on boot: instrumentation.ts), so events left in the outbox
 * by an earlier run go out too. Without ASAFARIM_NATS_URL there is no relay (logged once).
 */
export function startEventRelay(): Relay | undefined {
  if (globalForDb.flowRelay === undefined) {
    globalForDb.flowRelay = startAppRelay({ appId: manifest.id, pool: () => db() }) ?? null;
  }
  return globalForDb.flowRelay ?? undefined;
}
