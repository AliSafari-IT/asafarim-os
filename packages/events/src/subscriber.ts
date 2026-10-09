/**
 * Subscribing (P4.1, ADR 0001 §5): `subscribe(type, handler, opts)` consumes the durable consumer
 * `<consumer-app>.<type>` that core-api created on the publisher's stream, and runs the handler
 * EXACTLY ONCE per event id, inside the consuming app's own database transaction:
 *
 *   BEGIN → INSERT INTO asafarim_inbox (event_id) … ON CONFLICT DO NOTHING
 *         → a duplicate id: ROLLBACK, ack, the handler is not called
 *         → handler(event, tx) → COMMIT → ack            (ack only after commit)
 *   a handler error → ROLLBACK (no inbox row) → nak with a backoff delay → redelivered
 *   the `maxDeliver`-th failure → the envelope + failure metadata go to
 *         `deadletter.<consumer-app>.<type>` (DEADLETTER stream) → term: never redelivered
 *
 * A crash between COMMIT and the ack is safe: the redelivery finds the inbox row and is acked.
 * The subscriber never creates streams or consumers (core-api does): a missing consumer is retried
 * with a backoff, like the relay retries a missing stream.
 */
import { jetstream, type JetStreamClient, type JsMsg } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import { EVENT_TYPE, sourceFor, type CloudEvent } from "./envelope.ts";
import { INBOX_TABLE } from "./inbox-sql.ts";
import type { Queryable } from "./publisher.ts";
import { backoffDelay, type RelayLogger, type RelayPool } from "./relay.ts";
import { consumerName, deadLetterSubject, publisherOf, streamName } from "./streams.ts";

/** The handler gets the event and the transaction the inbox row is in: write with `tx`. */
export type EventHandler<T = unknown> = (event: CloudEvent<T>, tx: Queryable) => Promise<void>;

/** What a dead letter carries: the envelope as received, and why it was given up on. */
export interface DeadLetter {
  /** The original envelope (parsed), or the raw message text when it wasn't a valid envelope. */
  envelope: CloudEvent | string;
  failure: {
    consumer: string;
    type: string;
    reason: "max_deliver" | "invalid_envelope";
    /** Deliveries tried, including the last one. */
    attempts: number;
    /** The last error's message (truncated); never a stack trace. */
    error: string;
    stream: string;
    streamSeq: number;
    deadLetteredAt: string;
  };
}

/** One delivery, as the transaction wrapper sees it (a JetStream message, or a fake in tests). */
export interface Delivery {
  data: Uint8Array;
  /** 1 on the first delivery. */
  deliveryCount: number;
  stream: string;
  streamSeq: number;
  ack(): Promise<void>;
  nak(delayMs: number): void;
  term(reason: string): void;
}

export type DeliveryOutcome = "processed" | "duplicate" | "retry" | "dead_lettered";

export interface ProcessOptions<T> {
  appId: string;
  type: string;
  handler: EventHandler<T>;
  pool: RelayPool;
  /** Failed deliveries before the event is dead-lettered (default 5). */
  maxDeliver?: number;
  /** Delay before a failed event is redelivered: initialMs × 2^(n-1), capped (default 500 ms … 30 s). */
  backoff?: { initialMs?: number; maxMs?: number };
  /** Publishes a dead letter and resolves once the bus stored it. */
  deadLetter: (subject: string, letter: DeadLetter, msgId: string) => Promise<void>;
  log?: RelayLogger;
  now?: () => Date;
}

export const DEFAULT_MAX_DELIVER = 5;
const MAX_ERROR_LENGTH = 500;
const decoder = new TextDecoder();

/** Parse and check an envelope: JSON, CloudEvents 1.0, the subscribed type, from its publisher. */
export function parseEnvelope(data: Uint8Array, type: string): CloudEvent {
  const text = decoder.decode(data);
  let e: Partial<CloudEvent>;
  try {
    e = JSON.parse(text) as Partial<CloudEvent>;
  } catch {
    throw new TypeError("not JSON");
  }
  if (typeof e !== "object" || e === null) throw new TypeError("not a JSON object");
  if (e.specversion !== "1.0") throw new TypeError("specversion isn't 1.0");
  if (typeof e.id !== "string" || e.id.length === 0 || e.id.length > 128) throw new TypeError("no valid id");
  if (e.type !== type) throw new TypeError(`type is ${JSON.stringify(e.type)}, not ${type}`);
  if (e.source !== sourceFor(publisherOf(type)))
    throw new TypeError(`source ${JSON.stringify(e.source)} doesn't own ${type}`);
  return e as CloudEvent;
}

/**
 * Handle ONE delivery: the inbox insert and the handler in one transaction, the ack after the
 * commit, a nak (with a delay) or a dead letter on failure. Never throws for a handler error.
 */
export async function processDelivery<T>(o: ProcessOptions<T>, d: Delivery): Promise<DeliveryOutcome> {
  const maxDeliver = o.maxDeliver ?? DEFAULT_MAX_DELIVER;
  const consumer = consumerName(o.appId, o.type);

  const giveUp = async (reason: DeadLetter["failure"]["reason"], envelope: CloudEvent | string, error: string) => {
    const letter: DeadLetter = {
      envelope,
      failure: {
        consumer: o.appId,
        type: o.type,
        reason,
        attempts: d.deliveryCount,
        error: error.slice(0, MAX_ERROR_LENGTH),
        stream: d.stream,
        streamSeq: d.streamSeq,
        deadLetteredAt: (o.now?.() ?? new Date()).toISOString(),
      },
    };
    try {
      // One dead letter per stream message, even if it is published again after a lost PubAck.
      await o.deadLetter(deadLetterSubject(o.appId, o.type), letter, `${consumer}:${d.stream}:${d.streamSeq}`);
    } catch (err) {
      // Not stored: let the bus redeliver it, and dead-letter it then.
      o.log?.warn("events.subscriber.dead_letter_failed", {
        appId: o.appId,
        type: o.type,
        error: (err as Error).message,
      });
      d.nak(backoffDelay(d.deliveryCount, o.backoff?.initialMs ?? 500, o.backoff?.maxMs ?? 30_000));
      return "retry" as const;
    }
    d.term(`dead-lettered: ${reason}`);
    o.log?.warn("events.subscriber.dead_lettered", {
      appId: o.appId,
      type: o.type,
      reason,
      attempts: d.deliveryCount,
      eventId: typeof envelope === "string" ? undefined : envelope.id,
    });
    return "dead_lettered" as const;
  };

  let event: CloudEvent<T>;
  try {
    event = parseEnvelope(d.data, o.type) as CloudEvent<T>;
  } catch (err) {
    // It will never parse: retrying is pointless.
    return giveUp("invalid_envelope", decoder.decode(d.data).slice(0, 64 * 1024), (err as Error).message);
  }

  // A delivery past the limit is one whose dead letter couldn't be stored before: don't run the handler again.
  if (d.deliveryCount > maxDeliver) return giveUp("max_deliver", event, "the dead letter is being retried");

  let failure: Error | undefined;
  let duplicate = false;
  const client = await o.pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO ${INBOX_TABLE} (event_id, type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING`,
      [event.id, event.type],
    );
    if (inserted.rowCount === 0) {
      duplicate = true;
      await client.query("ROLLBACK");
    } else {
      await o.handler(event, client);
      await client.query("COMMIT");
    }
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
    await client.query("ROLLBACK").catch(() => undefined);
  } finally {
    client.release();
  }

  if (!failure) {
    await d.ack(); // only now: the change and the inbox row are committed
    return duplicate ? "duplicate" : "processed";
  }
  if (d.deliveryCount >= maxDeliver) return giveUp("max_deliver", event, failure.message);
  const delay = backoffDelay(d.deliveryCount, o.backoff?.initialMs ?? 500, o.backoff?.maxMs ?? 30_000);
  o.log?.warn("events.subscriber.failed", {
    appId: o.appId,
    type: o.type,
    eventId: event.id,
    attempt: d.deliveryCount,
    retryInMs: delay,
    error: failure.message.slice(0, MAX_ERROR_LENGTH),
  });
  d.nak(delay);
  return "retry";
}

export interface SubscribeOptions {
  /** The CONSUMING app's id (the durable consumer is `<appId>.<type>`). */
  appId: string;
  /** The consuming app's database (it holds `asafarim_inbox`), or a function that resolves it. */
  pool: RelayPool | (() => Promise<RelayPool>);
  /** NATS server URL(s); the subscriber connects (and reconnects) itself. */
  servers?: string | string[];
  /** Or hand it a JetStream client (tests); the subscriber then never closes it. */
  jetstream?: () => Promise<JetStreamClient>;
  /** Failed deliveries before the event is dead-lettered (default 5). */
  maxDeliver?: number;
  /** Redelivery delay after a handler error (default 500 ms … 30 s, doubling). */
  backoff?: { initialMs?: number; maxMs?: number };
  /** Retry delay while the bus or the consumer isn't there (default 250 ms … 10 s, doubling). */
  reconnectBackoff?: { initialMs?: number; maxMs?: number };
  log?: RelayLogger;
  /** Called after every delivery (tests, metrics). */
  onDelivery?: (outcome: DeliveryOutcome, eventId: string | undefined) => void;
}

export interface Subscription {
  readonly consumer: string;
  /** Stop consuming, wait for the delivery in progress, close the connection it opened. */
  stop(): Promise<void>;
}

const consoleLogger: RelayLogger = {
  info: (msg, detail) => console.log(JSON.stringify({ service: "events-subscriber", msg, ...detail })),
  warn: (msg, detail) => console.warn(JSON.stringify({ service: "events-subscriber", msg, ...detail })),
};

/**
 * Consume `type` in the app's durable consumer, one delivery at a time (in stream order), with the
 * inbox and the handler in one transaction. Returns at once; consuming runs until `stop()`.
 */
export function subscribe<T = unknown>(type: string, handler: EventHandler<T>, opts: SubscribeOptions): Subscription {
  if (!EVENT_TYPE.test(type)) throw new TypeError(`events: "${type}" must be <app>.<entity>.<verb>.v<N>`);
  if (!opts.servers && !opts.jetstream) throw new Error("events subscribe: give it `servers` or `jetstream`");
  const consumer = consumerName(opts.appId, type);
  const stream = streamName(publisherOf(type));
  const log = opts.log ?? consoleLogger;
  const encoder = new TextEncoder();

  let nc: Promise<NatsConnection> | undefined;
  async function js(): Promise<JetStreamClient> {
    if (opts.jetstream) return opts.jetstream();
    nc ??= connect({
      servers: opts.servers!,
      name: `${opts.appId}-subscriber`,
      timeout: 3000,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 1000,
    }).catch((err: unknown) => {
      nc = undefined;
      throw err;
    });
    return jetstream(await nc);
  }
  const pool = async () => (typeof opts.pool === "function" ? opts.pool() : opts.pool);

  let stopped = false;
  let messages: { stop(): void; close(): Promise<void | Error> } | undefined;
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

  async function handle(client: JetStreamClient, m: JsMsg) {
    const outcome = await processDelivery<T>(
      {
        appId: opts.appId,
        type,
        handler,
        pool: await pool(),
        maxDeliver: opts.maxDeliver,
        backoff: opts.backoff,
        log,
        deadLetter: async (subject, letter, msgId) => {
          await client.publish(subject, encoder.encode(JSON.stringify(letter)), { msgID: msgId });
        },
      },
      {
        data: m.data,
        deliveryCount: m.info.deliveryCount,
        stream: m.info.stream,
        streamSeq: m.info.streamSequence,
        ack: async () => {
          await m.ackAck();
        },
        nak: (ms) => m.nak(ms),
        term: (reason) => m.term(reason),
      },
    );
    let eventId: string | undefined;
    try {
      eventId = (m.json<{ id?: unknown }>().id as string | undefined) ?? undefined;
    } catch {
      eventId = undefined;
    }
    opts.onDelivery?.(outcome, eventId);
  }

  async function loop() {
    let failures = 0;
    while (!stopped) {
      try {
        const client = await js();
        const c = await client.consumers.get(stream, consumer);
        const iter = await c.consume({ max_messages: 10 });
        messages = iter;
        if (failures > 0)
          log.info("events.subscriber.recovered", { appId: opts.appId, consumer, afterFailures: failures });
        failures = 0;
        for await (const m of iter) {
          try {
            await handle(client, m);
          } catch (err) {
            // The database is down, or the ack failed: the bus redelivers after ack_wait.
            log.warn("events.subscriber.delivery_failed", {
              appId: opts.appId,
              consumer,
              error: (err as Error).message,
            });
          }
          if (stopped) break;
        }
        messages = undefined;
        if (!stopped) throw new Error("the consumer stopped delivering");
      } catch (err) {
        if (stopped) break;
        failures++;
        const delay = backoffDelay(failures, opts.reconnectBackoff?.initialMs, opts.reconnectBackoff?.maxMs);
        if (failures === 1 || failures % 10 === 0) {
          log.warn("events.subscriber.unavailable", {
            appId: opts.appId,
            consumer,
            failures,
            retryInMs: delay,
            error: (err as Error).message,
          });
        }
        await sleep(delay);
      }
    }
  }

  const running = loop();

  return {
    consumer,
    async stop() {
      stopped = true;
      messages?.stop();
      wakeUp?.();
      await running;
      const c = nc;
      nc = undefined;
      if (c) await (await c.catch(() => undefined))?.close();
    },
  };
}
