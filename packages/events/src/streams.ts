/**
 * Streams (P4.1): one JetStream stream per publishing app, `APP_<ID>` on subjects `<id>.>`, file
 * storage. Created by core-api when it installs an app that declares `events.publishes`, never by
 * the app or its relay (an app can't widen what it may publish by creating streams).
 */
import { jetstreamManager, JetStreamApiCodes, JetStreamApiError, StorageType } from "@nats-io/jetstream";
import type { JetStreamManager } from "@nats-io/jetstream";
import { nanos, type NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import { APP_ID } from "./envelope.ts";

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

/** What core-api holds: a lazily opened connection that ensures app streams. */
export interface StreamAdmin {
  ensureAppStream(appId: string): Promise<{ stream: string; result: EnsureResult }>;
  close(): Promise<void>;
}

export function createStreamAdmin(opts: {
  servers: string | string[];
  name?: string;
  timeoutMs?: number;
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
  return {
    async ensureAppStream(appId) {
      const nc = await open();
      const jsm = await jetstreamManager(nc, { timeout: opts.timeoutMs ?? 3000 });
      return { stream: streamName(appId), result: await ensureAppStream(jsm, appId) };
    },
    async close() {
      const c = conn;
      conn = undefined;
      if (c) await (await c.catch(() => undefined))?.close();
    },
  };
}
