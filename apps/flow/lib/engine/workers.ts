/**
 * What runs in the app process next to the pages (started by instrumentation.ts):
 *
 * - one subscriber per `events.subscribes` type: the inbox row and the engine's transition in one
 *   transaction (the SDK's `subscribe`), the audit entries written once it committed;
 * - the timeout sweeper, every 15 s: overdue waiting steps `timed_out`, one run per transaction,
 *   claimed with FOR UPDATE SKIP LOCKED so several instances share the work;
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

export async function runRetention(pool: pg.Pool, now = new Date()): Promise<number> {
  const cleared = await clearOldPayloads(pool, now);
  if (cleared) log.info("flow.retention.cleared", { steps: cleared });
  return cleared;
}

export interface Workers {
  stop(): Promise<void>;
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
  const sweep = guard("sweeper", async () => {
    if ((await sweepTimeouts(await opts.pool(), opts.engine)) > 0) opts.wake();
  });
  const retain = guard("retention", async () => runRetention(await opts.pool()));
  const sweeper = setInterval(sweep, SWEEP_EVERY_MS);
  const retention = setInterval(retain, RETENTION_EVERY_MS);
  const firstRetention = setTimeout(retain, 60_000);
  for (const t of [sweeper, retention, firstRetention]) t.unref();

  return {
    async stop() {
      clearInterval(sweeper);
      clearInterval(retention);
      clearTimeout(firstRetention);
      await Promise.all(subscriptions.map((s) => s.stop()));
    },
  };
}
