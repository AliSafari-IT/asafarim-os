/**
 * What runs in the app process next to the pages (started by instrumentation.ts):
 *
 * - one subscriber per `events.subscribes` type: the inbox row and the engine's transition in one
 *   transaction (the SDK's `subscribe`), the audit entries written once it committed;
 * - the timeout sweeper, every 15 s: overdue waiting steps `timed_out` (a wait resumes), one run per
 *   transaction, claimed with FOR UPDATE SKIP LOCKED so several instances share the work;
 * - the connector worker, every 2 s and right after a commit (`kick`): due connector steps called, a
 *   step a crashed process left `running` called again (lib/engine/connectors.ts: at least once);
 * - the retention job, daily (and once shortly after boot).
 */
import {
  busAuthFromEnv,
  subscribe,
  type CloudEvent,
  type Queryable,
  type Subscription,
} from "@asafarim/app-sdk/events";
import { traceEventHandler } from "@asafarim/telemetry";
import type pg from "pg";
import manifest from "../../platform.app";
import { writeAudit, type AuditEntry } from "../audit";
import { log } from "../log";
import type { Engine } from "./engine";
import { clearOldPayloads } from "./retention";

export const SWEEP_EVERY_MS = 15_000;
export const RETENTION_EVERY_MS = 24 * 60 * 60 * 1000;
/** Runs one sweep handles at most, so a backlog can't hold the interval. */
const SWEEP_BATCH = 100;

/** Time out every overdue run (up to SWEEP_BATCH), each in its own transaction; how many. */
export async function sweepTimeouts(pool: pg.Pool, engine: Engine): Promise<number> {
  let n = 0;
  while (n < SWEEP_BATCH) {
    const client = await pool.connect();
    let audits: AuditEntry[] = [];
    try {
      await client.query("BEGIN");
      const swept = await engine.sweepOne(client);
      await client.query("COMMIT");
      if (!swept) break;
      audits = swept.audits;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    writeAudit(audits);
    n++;
  }
  return n;
}

export const CONNECTORS_EVERY_MS = 2_000;
/** Calls one pass makes at most; passes running at once in this process at most. */
const CONNECTOR_BATCH = 50;
const CONNECTOR_PASSES = 4;

/** `fn` in one transaction on `pool`. */
async function inTx<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Call the due connector steps (up to CONNECTOR_BATCH), one at a time: claim it in one transaction,
 * call the connector with no transaction open, write the result and the next transition in another.
 * How many steps it handled.
 */
export async function runDueConnectors(pool: pg.Pool, engine: Engine): Promise<number> {
  let n = 0;
  while (n < CONNECTOR_BATCH) {
    const claimed = await inTx(pool, (tx) => engine.claimConnector(tx));
    if (!claimed) break;
    writeAudit(claimed.audits);
    n++;
    if (!claimed.claim) continue;
    const claim = claimed.claim;
    const outcome = await engine.invokeConnector(claim);
    writeAudit(await inTx(pool, (tx) => engine.completeConnector(tx, claim, outcome)));
  }
  return n;
}

export async function runRetention(pool: pg.Pool, now = new Date()): Promise<number> {
  const cleared = await clearOldPayloads(pool, now);
  if (cleared) log.info("flow.retention.cleared", { steps: cleared });
  return cleared;
}

export interface Workers {
  stop(): Promise<void>;
  /** Run the connector worker now (after a commit that may have left a connector step due). */
  kick(): void;
}

/**
 * Start the subscribers (when the platform gave the app a bus), the sweeper and the retention job.
 * `wake` nudges the relay after a transition wrote to the outbox.
 */
export function startWorkers(opts: {
  pool: () => Promise<pg.Pool>;
  engine: Engine;
  wake: () => void;
  env?: Record<string, string | undefined>;
}): Workers {
  const env = opts.env ?? process.env;
  const servers = env.ASAFARIM_NATS_URL?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const subscriptions: Subscription[] = [];
  // The audit entries of a delivery's transition, written once the subscriber reports it committed.
  const pending = new Map<string, AuditEntry[]>();

  if (servers?.length) {
    const auth = busAuthFromEnv(manifest.id, env);
    for (const { type } of manifest.events?.subscribes ?? []) {
      subscriptions.push(
        subscribe(
          type,
          traceEventHandler(async (event: CloudEvent, tx: Queryable) => {
            pending.set(event.id, await opts.engine.handle(tx, event));
          }),
          {
            appId: manifest.id,
            pool: opts.pool,
            servers,
            ...(auth ? { auth } : {}),
            log,
            onDelivery: (outcome, eventId) => {
              if (eventId === undefined) return;
              const audits = pending.get(eventId);
              pending.delete(eventId);
              if (outcome === "processed" && audits) {
                writeAudit(audits);
                opts.wake();
                kick();
              }
            },
          },
        ),
      );
    }
  } else {
    log.warn("flow.subscribers.no_bus", { hint: "ASAFARIM_NATS_URL is not set: no events are consumed" });
  }

  const guard = (what: string, job: () => Promise<unknown>) => () => {
    job().catch((err: unknown) => log.warn(`flow.${what}.failed`, { error: (err as Error).message }));
  };
  let passes = 0;
  const connectorPass = guard("connectors", async () => {
    if (passes >= CONNECTOR_PASSES) return;
    passes++;
    try {
      if ((await runDueConnectors(await opts.pool(), opts.engine)) > 0) opts.wake();
    } finally {
      passes--;
    }
  });
  function kick() {
    connectorPass();
  }
  const sweep = guard("sweeper", async () => {
    if ((await sweepTimeouts(await opts.pool(), opts.engine)) > 0) {
      opts.wake();
      kick();
    }
  });
  const retain = guard("retention", async () => runRetention(await opts.pool()));
  const sweeper = setInterval(sweep, SWEEP_EVERY_MS);
  const connectorTimer = setInterval(connectorPass, CONNECTORS_EVERY_MS);
  const retention = setInterval(retain, RETENTION_EVERY_MS);
  const firstRetention = setTimeout(retain, 60_000);
  for (const t of [sweeper, connectorTimer, retention, firstRetention]) t.unref();

  return {
    async stop() {
      clearInterval(sweeper);
      clearInterval(connectorTimer);
      clearInterval(retention);
      clearTimeout(firstRetention);
      await Promise.all(subscriptions.map((s) => s.stop()));
    },
    kick,
  };
}
