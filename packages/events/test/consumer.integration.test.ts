/**
 * Subscribing against a REAL Postgres and a REAL NATS JetStream (the dev stack: `pnpm dev`):
 * the durable consumer core-api creates, the inbox (exactly once), ack after commit, and dead
 * letters. Same variables and rules as relay.integration.test.ts (EVENTS_TEST_ADMIN_URL,
 * EVENTS_TEST_NATS_URL, EVENTS_TEST_REQUIRED). It creates a throwaway database, a throwaway
 * publisher stream and consumers, and removes them; the shared DEADLETTER stream stays (it is
 * core-api's), and only messages this run published are read from it.
 */
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DEADLETTER_STREAM,
  INBOX_SQL,
  consumerName,
  createEvent,
  createStreamAdmin,
  deadLetterSubject,
  ensureAppStream,
  ensureConsumer,
  streamName,
  subscribe,
  type CloudEvent,
  type DeadLetter,
  type DeliveryOutcome,
  type EventHandler,
  type RelayLogger,
  type StreamAdmin,
  type Subscription,
} from "../src/index.ts";

const ADMIN_URL = process.env.EVENTS_TEST_ADMIN_URL;
const NATS_URL = process.env.EVENTS_TEST_NATS_URL;
if (process.env.EVENTS_TEST_REQUIRED && (!ADMIN_URL || !NATS_URL)) {
  throw new Error("EVENTS_TEST_ADMIN_URL and EVENTS_TEST_NATS_URL must be set");
}

const run = Date.now().toString(36);
const PUB = `pub${run}`;
const TYPE = `${PUB}.thing.created.v1`;
const dbName = `events_sub_test_${run}`;
const quiet: RelayLogger = { info: () => undefined, warn: () => undefined };
const encoder = new TextEncoder();

describe.skipIf(!ADMIN_URL || !NATS_URL)("subscribe: inbox, ack after commit, dead letter (integration)", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let nc: NatsConnection;
  let js: JetStreamClient;
  let jsm: JetStreamManager;
  let busAdmin: StreamAdmin;
  const subs: Subscription[] = [];

  /** Publish an envelope straight to the stream (what the relay does), with its own Nats-Msg-Id. */
  async function publish(event: CloudEvent, msgId = event.id) {
    await js.publish(TYPE, encoder.encode(JSON.stringify(event)), { msgID: msgId });
  }
  const newEvent = (n: number) => createEvent({ source: PUB, type: TYPE, data: { n }, subject: `thing-${n}` });

  const inboxRows = async (id: string) =>
    Number((await pool.query("SELECT count(*) AS n FROM asafarim_inbox WHERE event_id = $1", [id])).rows[0].n);

  /** Start a subscriber for consumer app `app` with `handler`; records each delivery's outcome. */
  async function start(app: string, handler: EventHandler, extra: { maxDeliver?: number } = {}) {
    expect((await busAdmin.ensureConsumer(app, TYPE)).result).toBe("created");
    const outcomes: [DeliveryOutcome, string | undefined][] = [];
    const sub = subscribe(TYPE, handler, {
      appId: app,
      pool,
      servers: NATS_URL,
      maxDeliver: extra.maxDeliver ?? 50,
      backoff: { initialMs: 50, maxMs: 200 },
      log: quiet,
      onDelivery: (o, id) => outcomes.push([o, id]),
    });
    subs.push(sub);
    return { sub, outcomes };
  }

  const consumerState = async (app: string) => {
    const info = await jsm.consumers.info(streamName(PUB), consumerName(app, TYPE));
    return { pending: info.num_pending, ackPending: info.num_ack_pending, redelivered: info.num_redelivered };
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: url.href, max: 6 });
    pool.on("error", () => undefined);
    await pool.query(INBOX_SQL);
    await pool.query(INBOX_SQL); // idempotent
    await pool.query("CREATE TABLE effects (event_id text NOT NULL, consumer text NOT NULL)");
    nc = await connect({ servers: NATS_URL! });
    js = jetstream(nc);
    jsm = await jetstreamManager(nc);
    busAdmin = createStreamAdmin({ servers: NATS_URL! });
  });

  // Every consumer app here shares one test database (one inbox): only one subscriber runs at a time.
  afterEach(async () => {
    for (const s of subs.splice(0)) await s.stop();
  });

  afterAll(async () => {
    await jsm?.streams.delete(streamName(PUB)).catch(() => undefined); // its consumers go with it
    await busAdmin?.close();
    await nc?.close();
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  }, 30_000);

  it("core-api's ensureConsumer: no_stream before the publisher's stream exists; then created, then exists (idempotent)", async () => {
    expect(await ensureConsumer(jsm, `early${run}`, TYPE)).toBe("no_stream");
    expect(await ensureAppStream(jsm, PUB)).toBe("created");
    expect(await ensureConsumer(jsm, `early${run}`, TYPE)).toBe("created");
    expect(await ensureConsumer(jsm, `early${run}`, TYPE)).toBe("exists");
    const info = await jsm.consumers.info(streamName(PUB), consumerName(`early${run}`, TYPE));
    expect(info.config).toMatchObject({
      durable_name: consumerName(`early${run}`, TYPE),
      filter_subject: TYPE,
      ack_policy: "explicit",
      deliver_policy: "new",
    });
    // The admin also ensures the shared DEADLETTER stream on deadletter.>.
    await busAdmin.ensureDeadLetterStream();
    expect((await jsm.streams.info(DEADLETTER_STREAM)).config.subjects).toEqual(["deadletter.>"]);
  }, 30_000);

  it("an event is handled exactly once, with the envelope as published; the inbox has its row", async () => {
    const app = `once${run}`;
    const seen: CloudEvent[] = [];
    const { outcomes } = await start(app, async (e, tx) => {
      seen.push(e);
      await tx.query("INSERT INTO effects (event_id, consumer) VALUES ($1, $2)", [e.id, app]);
    });
    const e = newEvent(1);
    await publish(e);
    await expect.poll(() => seen.length, { timeout: 10_000 }).toBe(1);
    expect(seen[0]).toEqual(e);
    await expect.poll(() => outcomes, { timeout: 5000 }).toEqual([["processed", e.id]]);
    expect(await inboxRows(e.id)).toBe(1);
    await expect.poll(() => consumerState(app), { timeout: 5000 }).toMatchObject({ pending: 0, ackPending: 0 });
  }, 30_000);

  it("duplicate delivery (same event id, a new Nats-Msg-Id): the handler runs once, the second is acked, one inbox row", async () => {
    const app = `dup${run}`;
    let calls = 0;
    const { outcomes } = await start(app, async (e, tx) => {
      calls++;
      await tx.query("INSERT INTO effects (event_id, consumer) VALUES ($1, $2)", [e.id, app]);
    });
    const e = newEvent(2);
    await publish(e);
    await publish(e, `${e.id}-again`); // JetStream's own dedupe doesn't catch it; the inbox must
    await expect.poll(() => outcomes.length, { timeout: 10_000 }).toBe(2);
    expect(outcomes).toEqual([
      ["processed", e.id],
      ["duplicate", e.id],
    ]);
    expect(calls).toBe(1);
    expect(await inboxRows(e.id)).toBe(1);
    const effects = await pool.query("SELECT count(*) AS n FROM effects WHERE event_id = $1 AND consumer = $2", [
      e.id,
      app,
    ]);
    expect(Number(effects.rows[0].n)).toBe(1);
    await expect.poll(() => consumerState(app), { timeout: 5000 }).toMatchObject({ pending: 0, ackPending: 0 });
  }, 30_000);

  it("ack after commit: a handler that throws → rolled back, no inbox row, redelivered; once fixed, processed once", async () => {
    const app = `retry${run}`;
    let broken = true;
    const attempts: number[] = [];
    let inboxDuringFailure = -1;
    const { outcomes } = await start(app, async (e, tx) => {
      attempts.push(Date.now());
      await tx.query("INSERT INTO effects (event_id, consumer) VALUES ($1, $2)", [e.id, app]);
      if (broken) throw new Error("not yet");
    });
    const e = newEvent(3);
    await publish(e);
    await expect.poll(() => outcomes.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    expect(outcomes[0]).toEqual(["retry", e.id]);
    // Rolled back: neither the handler's write nor the inbox row survived.
    inboxDuringFailure = await inboxRows(e.id);
    expect(inboxDuringFailure).toBe(0);
    const effectsBefore = await pool.query("SELECT count(*) AS n FROM effects WHERE consumer = $1", [app]);
    expect(Number(effectsBefore.rows[0].n)).toBe(0);

    broken = false;
    await expect.poll(() => outcomes.at(-1)?.[0], { timeout: 10_000 }).toBe("processed");
    expect(outcomes.filter(([o]) => o === "processed")).toHaveLength(1);
    expect(attempts.length).toBeGreaterThanOrEqual(2); // it was redelivered
    expect(await inboxRows(e.id)).toBe(1);
    const effects = await pool.query("SELECT count(*) AS n FROM effects WHERE consumer = $1", [app]);
    expect(Number(effects.rows[0].n)).toBe(1);
    await expect.poll(() => consumerState(app), { timeout: 5000 }).toMatchObject({ pending: 0, ackPending: 0 });
  }, 30_000);

  it("dead letter: a handler that always throws → after N attempts the envelope is on deadletter.<app>.<type>, not redelivered", async () => {
    const app = `dead${run}`;
    const N = 3;
    let calls = 0;
    const { outcomes } = await start(
      app,
      async () => {
        calls++;
        throw new Error("permanently broken");
      },
      { maxDeliver: N },
    );
    const dlBefore = (await jsm.streams.info(DEADLETTER_STREAM)).state.last_seq;
    const e = newEvent(4);
    await publish(e);
    await expect.poll(() => outcomes.at(-1)?.[0], { timeout: 15_000 }).toBe("dead_lettered");
    expect(outcomes.map(([o]) => o)).toEqual(["retry", "retry", "dead_lettered"]);
    expect(calls).toBe(N);

    // The dead letter: the original envelope and the failure metadata, on its own subject.
    const consumer = await js.consumers.get(DEADLETTER_STREAM, {
      opt_start_seq: dlBefore + 1,
      filter_subjects: [deadLetterSubject(app, TYPE)],
    });
    const m = await consumer.next({ expires: 3000 });
    expect(m?.subject).toBe(`deadletter.${app}.${TYPE}`);
    const letter = m!.json<DeadLetter>();
    expect(letter.envelope).toEqual(e);
    expect(letter.failure).toMatchObject({
      consumer: app,
      type: TYPE,
      reason: "max_deliver",
      attempts: N,
      error: "permanently broken",
      stream: streamName(PUB),
    });
    expect(await inboxRows(e.id)).toBe(0);

    // Terminated: no further delivery.
    await new Promise((r) => setTimeout(r, 1000));
    expect(calls).toBe(N);
    await expect.poll(() => consumerState(app), { timeout: 5000 }).toMatchObject({ pending: 0, ackPending: 0 });
  }, 30_000);
});
