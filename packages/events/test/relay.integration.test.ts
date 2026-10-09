/**
 * The outbox and relay against a REAL Postgres and a REAL NATS JetStream (the dev stack: `pnpm dev`).
 *
 * Needs EVENTS_TEST_ADMIN_URL (a superuser URL on a DEV Postgres, e.g.
 * postgres://postgres:postgres-dev-only@127.0.0.1:55440/postgres) and EVENTS_TEST_NATS_URL
 * (e.g. nats://127.0.0.1:54222). It creates a throwaway database and a throwaway stream for a
 * uniquely named app, and removes both afterwards. Skipped without them, except when
 * EVENTS_TEST_REQUIRED is set (CI), where it fails instead.
 */
import { jetstream, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OUTBOX_SQL,
  createPublisher,
  ensureAppStream,
  startRelay,
  streamName,
  type CloudEvent,
  type RelayLogger,
} from "../src/index.ts";

const ADMIN_URL = process.env.EVENTS_TEST_ADMIN_URL;
const NATS_URL = process.env.EVENTS_TEST_NATS_URL;
if (process.env.EVENTS_TEST_REQUIRED && (!ADMIN_URL || !NATS_URL)) {
  throw new Error("EVENTS_TEST_ADMIN_URL and EVENTS_TEST_NATS_URL must be set");
}

const run = Date.now().toString(36);
const APP = `evt${run}`;
const TYPE = `${APP}.thing.created.v1`;
const dbName = `events_test_${run}`;
const quiet: RelayLogger = { info: () => undefined, warn: () => undefined };

const manifest = { id: APP, events: { publishes: [{ type: TYPE, schema: "./thing.json" }] } };
const schemas = {
  "./thing.json": {
    type: "object",
    required: ["n"],
    additionalProperties: false,
    properties: { n: { type: "integer" } },
  },
};

describe.skipIf(!ADMIN_URL || !NATS_URL)("outbox + relay (integration: Postgres + JetStream)", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let nc: NatsConnection;
  let jsm: JetStreamManager;
  const publisher = createPublisher({ manifest, schemas });

  /** Publish `n` events in one transaction (or roll it back). */
  async function publishInTx(ns: number[], { rollback = false } = {}) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const events: CloudEvent[] = [];
      for (const n of ns) events.push(await publisher.publish(c, TYPE, { n }, { subject: `thing-${n}` }));
      await c.query(rollback ? "ROLLBACK" : "COMMIT");
      return events;
    } finally {
      c.release();
    }
  }

  /** Every message in the app's stream from `fromSeq` on, read with a test-only ordered consumer. */
  async function streamMessages(fromSeq = 1) {
    const info = await jsm.streams.info(streamName(APP));
    const last = info.state.last_seq;
    if (last < fromSeq) return [];
    const consumer = await jetstream(nc).consumers.get(streamName(APP), { opt_start_seq: fromSeq });
    const out: { subject: string; msgId?: string; event: CloudEvent }[] = [];
    const msgs = await consumer.fetch({ max_messages: last - fromSeq + 1, expires: 2000 });
    for await (const m of msgs) {
      out.push({ subject: m.subject, msgId: m.headers?.get("Nats-Msg-Id"), event: m.json<CloudEvent>() });
      if (m.seq >= last) break;
    }
    return out;
  }

  const lastSeq = async () => (await jsm.streams.info(streamName(APP))).state.last_seq;
  const pending = async () =>
    Number((await pool.query("SELECT count(*) AS n FROM asafarim_outbox WHERE sent_at IS NULL")).rows[0].n);

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.href, max: 4 });
    // The teardown's DROP DATABASE … WITH (FORCE) can reach a connection that is still closing;
    // pg reports that on the pool, and an unhandled pool error would fail the run.
    pool.on("error", () => undefined);
    await pool.query(OUTBOX_SQL);
    await pool.query(OUTBOX_SQL); // idempotent
    nc = await connect({ servers: NATS_URL! });
    jsm = await jetstreamManager(nc);
  });

  afterAll(async () => {
    await jsm?.streams.delete(streamName(APP)).catch(() => undefined);
    await nc?.close();
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it("without the app's stream the relay fails, keeps the rows and records the attempt (it never creates a stream)", async () => {
    const [e] = await publishInTx([0]);
    const relay = startRelay({
      appId: APP,
      pool,
      servers: NATS_URL,
      autoStart: false,
      publishTimeoutMs: 500,
      log: quiet,
    });
    await expect(relay.drain()).rejects.toThrow();
    await relay.stop();
    const { rows } = await pool.query("SELECT id, attempts, last_error, sent_at FROM asafarim_outbox");
    expect(rows).toEqual([{ id: e!.id, attempts: 1, last_error: expect.any(String), sent_at: null }]);
    await expect(jsm.streams.info(streamName(APP))).rejects.toThrow(/stream not found/i);
  });

  it("core-api's ensureAppStream creates APP_<ID> on <id>.> (idempotent); the waiting row is then delivered", async () => {
    expect(await ensureAppStream(jsm, APP)).toBe("created");
    expect(await ensureAppStream(jsm, APP)).toBe("exists");
    const info = await jsm.streams.info(streamName(APP));
    expect(info.config.subjects).toEqual([`${APP}.>`]);
    expect(info.config.storage).toBe("file");

    const relay = startRelay({ appId: APP, pool, servers: NATS_URL, autoStart: false, log: quiet });
    expect(await relay.drain()).toBe(1);
    await relay.stop();
    expect(await pending()).toBe(0);
    expect((await streamMessages()).map((m) => m.event.data)).toEqual([{ n: 0 }]);
  });

  it("a committed publish reaches the stream exactly once, with the envelope as written and Nats-Msg-Id = event id", async () => {
    const from = (await lastSeq()) + 1;
    const [e] = await publishInTx([1]);
    const relay = startRelay({ appId: APP, pool, servers: NATS_URL, pollMs: 50, log: quiet });
    await expect.poll(pending, { timeout: 10_000 }).toBe(0);
    await relay.stop();
    const msgs = await streamMessages(from);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ subject: TYPE, msgId: e!.id, event: e });
    expect(msgs[0]!.event).toMatchObject({
      specversion: "1.0",
      source: `asafarim://${APP}`,
      type: TYPE,
      subject: "thing-1",
      datacontenttype: "application/json",
      data: { n: 1 },
    });
  });

  it("a rolled-back transaction leaves no outbox row and publishes nothing", async () => {
    const from = (await lastSeq()) + 1;
    await publishInTx([99], { rollback: true });
    const relay = startRelay({ appId: APP, pool, servers: NATS_URL, autoStart: false, log: quiet });
    expect(await relay.drain()).toBe(0);
    await relay.stop();
    expect(await streamMessages(from)).toEqual([]);
  });

  it("re-running the relay over rows already published adds nothing: JetStream drops them by Nats-Msg-Id", async () => {
    const from = (await lastSeq()) + 1;
    const events = await publishInTx([2, 3, 4]);
    const relay = startRelay({ appId: APP, pool, servers: NATS_URL, autoStart: false, log: quiet });
    expect(await relay.drain()).toBe(3);
    // A crash after the PubAcks but before the rows were marked: they are pending again.
    await pool.query("UPDATE asafarim_outbox SET sent_at = NULL WHERE id = ANY($1)", [events.map((e) => e.id)]);
    expect(await pending()).toBe(3);
    expect(await relay.drain()).toBe(3); // acknowledged as duplicates, marked sent
    await relay.stop();
    expect(await pending()).toBe(0);
    const msgs = await streamMessages(from);
    expect(msgs.map((m) => m.event.id)).toEqual(events.map((e) => e.id)); // once each, in order
  });

  it("keeps the order across batches and never deletes a row", async () => {
    const from = (await lastSeq()) + 1;
    const before = Number((await pool.query("SELECT count(*) AS n FROM asafarim_outbox")).rows[0].n);
    const events = await publishInTx([10, 11, 12, 13, 14]);
    const relay = startRelay({ appId: APP, pool, servers: NATS_URL, autoStart: false, batchSize: 2, log: quiet });
    expect(await relay.drain()).toBe(5);
    await relay.stop();
    expect((await streamMessages(from)).map((m) => m.event.id)).toEqual(events.map((e) => e.id));
    expect(Number((await pool.query("SELECT count(*) AS n FROM asafarim_outbox")).rows[0].n)).toBe(before + 5);
  });
});
