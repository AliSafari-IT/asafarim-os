/**
 * The outbox relay (P4.1): an in-process loop that publishes pending outbox rows to JetStream,
 * oldest first, each with `Nats-Msg-Id` = the event id, so JetStream itself drops a re-send
 * (a crash between the PubAck and marking the row sent, or a publish that timed out but landed).
 *
 *  - a row is marked sent only after JetStream acknowledged it (a duplicate ack counts);
 *  - a failure keeps the row (attempts + last_error), stops the batch so order is kept, and
 *    backs off (capped exponential) before the next try;
 *  - unsent rows are never deleted;
 *  - it never creates streams: a missing stream is a failure like any other (core-api creates them).
 *
 * Several relays on one database (several app processes) don't send a row twice at once: a batch
 * holds its rows with FOR UPDATE SKIP LOCKED until it commits.
 */
import { jetstream, type JetStreamClient } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import { busConnectOptions, type BusAuth } from "./bus-auth.ts";
import { connect } from "@nats-io/transport-node";
import { OUTBOX_TABLE } from "./outbox-sql.ts";

export interface RelayClient {
  query<R = unknown>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
  release(): void;
}
/** A `pg.Pool` (structurally). */
export interface RelayPool {
  connect(): Promise<RelayClient>;
}

export interface RelayLogger {
  info(msg: string, detail?: object): void;
  warn(msg: string, detail?: object): void;
}

const consoleLogger: RelayLogger = {
  info: (msg, detail) => console.log(JSON.stringify({ service: "events-relay", msg, ...detail })),
  warn: (msg, detail) => console.warn(JSON.stringify({ service: "events-relay", msg, ...detail })),
};

export interface RelayOptions {
  appId: string;
  /** The app's database, or a function that resolves it (e.g. after the app's own migrations ran). */
  pool: RelayPool | (() => Promise<RelayPool>);
  /** NATS server URL(s); the relay connects (and reconnects) itself. */
  servers?: string | string[];
  /**
   * How the relay signs in to a bus that checks identities (P4.1 PR 4): the user and a function that
   * returns a fresh password for EVERY connect and reconnect (a signed, single-use assertion).
   */
  auth?: BusAuth;
  /** Or hand it a JetStream client (tests); the relay then never closes it. */
  jetstream?: () => Promise<JetStreamClient>;
  /** Rows per batch (default 100). */
  batchSize?: number;
  /** How often to look for new rows when idle (default 500 ms). `wake()` skips the wait. */
  pollMs?: number;
  /** Backoff after a failure: initialMs × 2^(n-1), capped at maxMs (default 250 ms … 10 s). */
  backoff?: { initialMs?: number; maxMs?: number };
  /** How long to wait for each PubAck (default 2 s). */
  publishTimeoutMs?: number;
  log?: RelayLogger;
  /** false: don't start the loop; call `drain()` by hand (tests). Default true. */
  autoStart?: boolean;
}

export interface Relay {
  /** Publish pending rows now, batch after batch, until none is left. Returns how many were sent. Throws on a failure. */
  drain(): Promise<number>;
  /** Skip the idle wait (call after a commit that wrote outbox rows). */
  wake(): void;
  /** Stop the loop, wait for the current batch, close the connection the relay opened. */
  stop(): Promise<void>;
  /** Consecutive failures so far (0 when healthy). */
  readonly failures: number;
}

interface OutboxRow {
  seq: string;
  id: string;
  type: string;
  envelope: unknown;
}

export const backoffDelay = (failures: number, initialMs = 250, maxMs = 10_000) =>
  failures <= 0 ? 0 : Math.min(maxMs, initialMs * 2 ** Math.min(failures - 1, 30));

export function startRelay(opts: RelayOptions): Relay {
  if (!opts.servers && !opts.jetstream) throw new Error("events relay: give it `servers` or `jetstream`");
  const log = opts.log ?? consoleLogger;
  const batchSize = opts.batchSize ?? 100;
  const pollMs = opts.pollMs ?? 500;
  const publishTimeout = opts.publishTimeoutMs ?? 2000;
  const encoder = new TextEncoder();

  let nc: Promise<NatsConnection> | undefined;
  async function js(): Promise<JetStreamClient> {
    if (opts.jetstream) return opts.jetstream();
    nc ??= connect({
      servers: opts.servers!,
      ...(opts.auth ? busConnectOptions(opts.auth) : {}),
      name: `${opts.appId}-outbox-relay`,
      timeout: 3000,
      maxReconnectAttempts: -1, // once connected, keep trying for ever
      reconnectTimeWait: 1000,
    }).catch((err: unknown) => {
      nc = undefined; // not up yet: the next batch tries to connect again
      throw err;
    });
    return jetstream(await nc, { timeout: publishTimeout });
  }

  const pool = async () => (typeof opts.pool === "function" ? opts.pool() : opts.pool);

  /** One batch inside one transaction. Returns how many rows were sent. */
  async function batch(): Promise<number> {
    const client = await (await pool()).connect();
    let failure: Error | undefined;
    let sent = 0;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<OutboxRow>(
        `SELECT seq, id, type, envelope FROM ${OUTBOX_TABLE} WHERE sent_at IS NULL ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );
      if (rows.length > 0) {
        const client_ = await js();
        for (const row of rows) {
          try {
            await client_.publish(row.type, encoder.encode(JSON.stringify(row.envelope)), {
              msgID: row.id,
              timeout: publishTimeout,
            });
          } catch (err) {
            failure = err as Error;
            await client.query(`UPDATE ${OUTBOX_TABLE} SET attempts = attempts + 1, last_error = $2 WHERE seq = $1`, [
              row.seq,
              String(failure.message).slice(0, 500),
            ]);
            break; // keep the order: nothing after a failed row goes first
          }
          await client.query(
            `UPDATE ${OUTBOX_TABLE} SET attempts = attempts + 1, last_error = NULL, sent_at = now() WHERE seq = $1`,
            [row.seq],
          );
          sent++;
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    if (failure) throw failure;
    return sent;
  }

  async function drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await batch();
      total += n;
      if (n < batchSize) return total;
    }
  }

  let stopped = false;
  let failures = 0;
  let wakeUp: (() => void) | undefined;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        wakeUp = undefined;
        resolve();
      }
      wakeUp = done;
    });

  async function loop() {
    while (!stopped) {
      try {
        const n = await drain();
        if (failures > 0) log.info("events.relay.recovered", { appId: opts.appId, afterFailures: failures });
        failures = 0;
        if (n > 0) log.info("events.relay.sent", { appId: opts.appId, count: n });
        if (!stopped) await sleep(pollMs);
      } catch (err) {
        failures++;
        const delay = backoffDelay(failures, opts.backoff?.initialMs, opts.backoff?.maxMs);
        // Log the first failure and then every 10th, so a long outage doesn't flood the log.
        if (failures === 1 || failures % 10 === 0) {
          log.warn("events.relay.failed", {
            appId: opts.appId,
            failures,
            retryInMs: delay,
            error: (err as Error).message,
          });
        }
        if (!stopped) await sleep(delay);
      }
    }
  }

  const running = opts.autoStart === false ? Promise.resolve() : loop();

  return {
    drain,
    wake: () => wakeUp?.(),
    async stop() {
      stopped = true;
      wakeUp?.();
      await running;
      const c = nc;
      nc = undefined;
      if (c) await (await c.catch(() => undefined))?.close();
    },
    get failures() {
      return failures;
    },
  };
}
