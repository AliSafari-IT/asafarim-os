/**
 * Streams (P4.1): one JetStream stream per publishing app, `APP_<ID>` on subjects `<id>.>`, file
 * storage. Created by core-api when it installs an app that declares `events.publishes`, never by
 * the app or its relay (an app can't widen what it may publish by creating streams).
 *
 * Durable consumers (`<consumer-app>.<type>` on the publisher's stream) and the shared DEADLETTER
 * stream (`deadletter.>`) are core-api's too: the subscriber only consumes.
 */
import {
  AckPolicy,
  DeliverPolicy,
  jetstreamManager,
  JetStreamApiCodes,
  JetStreamApiError,
  StorageType,
} from "@nats-io/jetstream";
import type { JetStreamManager } from "@nats-io/jetstream";
import { nanos, type NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import { APP_ID, EVENT_TYPE } from "./envelope.ts";

/** How long JetStream remembers a `Nats-Msg-Id` to drop a re-sent event (the relay retries well inside it). */
export const DUPLICATE_WINDOW_MS = 10 * 60_000;

export const streamName = (appId: string) => {
  if (!APP_ID.test(appId)) throw new TypeError(`events: "${appId}" is not an app id`);
  return `APP_${appId.toUpperCase().replace(/-/g, "_")}`;
};
export const streamSubjects = (appId: string) => [`${appId}.>`];

export type EnsureResult = "created" | "updated" | "exists";

const isStreamNotFound = (err: unknown) =>
  err instanceof JetStreamApiError && err.code === JetStreamApiCodes.StreamNotFound;

/** Create (or bring back in line) the app's stream. Idempotent. */
export async function ensureAppStream(jsm: JetStreamManager, appId: string): Promise<EnsureResult> {
  const name = streamName(appId);
  const subjects = streamSubjects(appId);
  try {
    const info = await jsm.streams.info(name);
    const same =
      info.config.subjects?.length === subjects.length && subjects.every((s) => info.config.subjects?.includes(s));
    if (same) return "exists";
    await jsm.streams.update(name, { subjects });
    return "updated";
  } catch (err) {
    if (!isStreamNotFound(err)) throw err;
  }
  await jsm.streams.add({
    name,
    subjects,
    storage: StorageType.File,
    duplicate_window: nanos(DUPLICATE_WINDOW_MS),
  });
  return "created";
}

const isConsumerNotFound = (err: unknown) =>
  err instanceof JetStreamApiError && err.code === JetStreamApiCodes.ConsumerNotFound;

/** The app that publishes `type` (its namespace: `notes.note.created.v1` → `notes`). */
export const publisherOf = (type: string) => {
  if (!EVENT_TYPE.test(type)) throw new TypeError(`events: "${type}" must be <app>.<entity>.<verb>.v<N>`);
  return type.slice(0, type.indexOf("."));
};

/**
 * The durable consumer of `type` for the consuming app: `<consumer-app>.<type>`, sanitised for
 * NATS consumer names (no `.`, `*`, `>`, whitespace or path separators): every `.` becomes `_`.
 * App ids and event types never contain `_`, so two pairs never map to the same name.
 */
export const consumerName = (consumerApp: string, type: string) => {
  if (!APP_ID.test(consumerApp)) throw new TypeError(`events: "${consumerApp}" is not an app id`);
  publisherOf(type); // validates the type
  return `${consumerApp}.${type}`.replace(/\./g, "_");
};

/** One stream for every app's dead letters, created by core-api, never by an app. */
export const DEADLETTER_STREAM = "DEADLETTER";
export const DEADLETTER_SUBJECTS = ["deadletter.>"];
/** Where the subscriber of `type` in `consumerApp` puts an event it gave up on. */
export const deadLetterSubject = (consumerApp: string, type: string) => {
  consumerName(consumerApp, type); // validates both
  return `deadletter.${consumerApp}.${type}`;
};
/** How long a dead letter is kept (30 days): long enough to look at it and replay it by hand. */
export const DEADLETTER_MAX_AGE_MS = 30 * 24 * 3600_000;

/** Create (or bring back in line) the DEADLETTER stream on `deadletter.>`. Idempotent. */
export async function ensureDeadLetterStream(jsm: JetStreamManager): Promise<EnsureResult> {
  try {
    const info = await jsm.streams.info(DEADLETTER_STREAM);
    const same =
      info.config.subjects?.length === DEADLETTER_SUBJECTS.length &&
      DEADLETTER_SUBJECTS.every((s) => info.config.subjects?.includes(s));
    if (same) return "exists";
    await jsm.streams.update(DEADLETTER_STREAM, { subjects: DEADLETTER_SUBJECTS });
    return "updated";
  } catch (err) {
    if (!isStreamNotFound(err)) throw err;
  }
  await jsm.streams.add({
    name: DEADLETTER_STREAM,
    subjects: DEADLETTER_SUBJECTS,
    storage: StorageType.File,
    duplicate_window: nanos(DUPLICATE_WINDOW_MS),
    max_age: nanos(DEADLETTER_MAX_AGE_MS),
  });
  return "created";
}

/** How long the bus waits for an ack before it redelivers (the handler crashed or hung). */
export const DEFAULT_ACK_WAIT_MS = 30_000;

export interface ConsumerOptions {
  /** Default 30 s. */
  ackWaitMs?: number;
  /**
   * The bus's own delivery cap. Default -1 (unlimited): the subscriber counts attempts itself and
   * dead-letters after its `maxDeliver` failures, so a dead letter that couldn't be published yet
   * is still redelivered (and dead-lettered then) rather than silently dropped by the bus.
   */
  maxDeliver?: number;
  /** Redelivery delays the bus applies when an ack times out (JetStream `backoff`). */
  backoffMs?: number[];
}

export type EnsureConsumerResult = EnsureResult | "no_stream";

/**
 * Create (or bring back in line) the durable consumer `<consumer-app>.<type>` on the publisher's
 * stream: filter = the event's subject, explicit ack, new messages only (from when it was created).
 * Idempotent. `no_stream` when the publisher's stream doesn't exist (yet): nothing is created.
 */
export async function ensureConsumer(
  jsm: JetStreamManager,
  consumerApp: string,
  type: string,
  opts: ConsumerOptions = {},
): Promise<EnsureConsumerResult> {
  const stream = streamName(publisherOf(type));
  const name = consumerName(consumerApp, type);
  const ackWait = nanos(opts.ackWaitMs ?? DEFAULT_ACK_WAIT_MS);
  const maxDeliver = opts.maxDeliver ?? -1;
  const backoff = opts.backoffMs?.map((ms) => nanos(ms));
  try {
    await jsm.streams.info(stream);
  } catch (err) {
    if (isStreamNotFound(err)) return "no_stream";
    throw err;
  }
  try {
    const info = await jsm.consumers.info(stream, name);
    const c = info.config;
    const same =
      c.filter_subject === type &&
      c.ack_wait === ackWait &&
      (c.max_deliver ?? -1) === maxDeliver &&
      JSON.stringify(c.backoff ?? []) === JSON.stringify(backoff ?? []);
    if (same) return "exists";
    await jsm.consumers.update(stream, name, {
      filter_subject: type,
      ack_wait: ackWait,
      max_deliver: maxDeliver,
      ...(backoff ? { backoff } : {}),
    });
    return "updated";
  } catch (err) {
    if (!isConsumerNotFound(err)) throw err;
  }
  await jsm.consumers.add(stream, {
    durable_name: name,
    filter_subject: type,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.New,
    ack_wait: ackWait,
    max_deliver: maxDeliver,
    ...(backoff ? { backoff } : {}),
  });
  return "created";
}

/** What core-api holds: a lazily opened connection that ensures app streams. */
export interface StreamAdmin {
  ensureAppStream(appId: string): Promise<{ stream: string; result: EnsureResult }>;
  /** The durable consumer of `type` for `consumerApp` (and the DEADLETTER stream, once). */
  ensureConsumer(consumerApp: string, type: string): Promise<{ consumer: string; result: EnsureConsumerResult }>;
  ensureDeadLetterStream(): Promise<{ stream: string; result: EnsureResult }>;
  close(): Promise<void>;
}

export function createStreamAdmin(opts: {
  servers: string | string[];
  name?: string;
  timeoutMs?: number;
  /** Options for the durable consumers it creates. */
  consumer?: ConsumerOptions;
}): StreamAdmin {
  let conn: Promise<NatsConnection> | undefined;
  const open = () => {
    conn ??= connect({
      servers: opts.servers,
      name: opts.name ?? "core-api",
      timeout: opts.timeoutMs ?? 3000,
      maxReconnectAttempts: -1,
    }).catch((err: unknown) => {
      conn = undefined; // try again next time
      throw err;
    });
    return conn;
  };
  const manager = async () => jetstreamManager(await open(), { timeout: opts.timeoutMs ?? 3000 });
  let deadLetter: Promise<EnsureResult> | undefined;
  const ensureDeadLetter = async () => {
    const jsm = await manager();
    deadLetter ??= ensureDeadLetterStream(jsm).catch((err: unknown) => {
      deadLetter = undefined; // try again next time
      throw err;
    });
    return deadLetter;
  };
  return {
    async ensureAppStream(appId) {
      return { stream: streamName(appId), result: await ensureAppStream(await manager(), appId) };
    },
    async ensureDeadLetterStream() {
      return { stream: DEADLETTER_STREAM, result: await ensureDeadLetter() };
    },
    async ensureConsumer(consumerApp, type) {
      await ensureDeadLetter();
      return {
        consumer: consumerName(consumerApp, type),
        result: await ensureConsumer(await manager(), consumerApp, type, opts.consumer),
      };
    },
    async close() {
      const c = conn;
      conn = undefined;
      deadLetter = undefined;
      if (c) await (await c.catch(() => undefined))?.close();
    },
  };
}
