/**
 * P4.1 PR 4: per-app identities on the event bus, against a REAL NATS (started with the dev
 * `auth_callout` config, scripts/dev/nats/nats.conf) and a real Postgres. core-api's responder
 * answers every connect; the test apps sign in with their own registry credential.
 *
 *  - anonymous and forged connects are refused;
 *  - app A publishes `A.x`, not `B.x`; can't pull from or ack on B's durable; can't create streams
 *    or consumers;
 *  - the notes-style flow (outbox → relay → JetStream → subscriber) still delivers exactly once,
 *    with both sides on their own identity;
 *  - an upgrade that adds a subscription: after a reconnect the app can pull from the new durable;
 *  - core-api down: connects fail, the relay keeps the event in the outbox, and it goes out once
 *    core-api is back.
 *
 * Needs CORE_API_TEST_ADMIN_URL, CORE_API_TEST_NATS_URL, NATS_CORE_PASSWORD and
 * CORE_API_NATS_ISSUER_SEED (the dev values, `.dev/nats.env` and `.dev/core-api.env`). Skipped
 * without them, except when CORE_API_TEST_REQUIRED is set (CI), where it fails instead.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  INBOX_SQL,
  OUTBOX_SQL,
  consumerName,
  createEvent,
  createStreamAdmin,
  startRelay,
  streamName,
  subscribe,
  type Relay,
  type StreamAdmin,
  type Subscription,
} from "@asafarim/events";
import { natsInboxPrefix, signNatsConnect } from "@asafarim/registry-protocol";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signRegistration } from "../src/credentials.ts";
import { migrate } from "../src/migrate.ts";
import { startAuthCallout, type AuthCallout } from "../src/nats-auth.ts";
import { createRegistry } from "../src/registry.ts";
import { createHandler } from "../src/server.ts";

const ADMIN_URL = process.env.CORE_API_TEST_ADMIN_URL;
const NATS_URL = process.env.CORE_API_TEST_NATS_URL;
const CORE_PASSWORD = process.env.NATS_CORE_PASSWORD;
const ISSUER_SEED = process.env.CORE_API_NATS_ISSUER_SEED;
const ready = Boolean(ADMIN_URL && NATS_URL && CORE_PASSWORD && ISSUER_SEED);
if (process.env.CORE_API_TEST_REQUIRED && !ready) {
  throw new Error(
    "CORE_API_TEST_ADMIN_URL, CORE_API_TEST_NATS_URL, NATS_CORE_PASSWORD and CORE_API_NATS_ISSUER_SEED must be set",
  );
}

const run = Date.now().toString(36);
const coreDb = `core_natsauth_test_${run}`;
const pubDb = `natsauth_pub_${run}`;
const subDb = `natsauth_sub_${run}`;
const A = `ana${run}`; // publishes
const B = `bob${run}`; // publishes; the isolation target
const S = `sue${run}`; // subscribes to A's type
const U = `upg${run}`; // installed quiet; an upgrade subscribes it to B's type
const typeOf = (id: string) => `${id}.thing.created.v1`;
const ADMIN_TOKEN = "t".repeat(40);
const enc = new TextEncoder();

function manifest(id: string, publishes: boolean, subscribes: string[] = []) {
  return {
    id,
    name: "Bus auth test",
    version: "0.1.0",
    platform: ">=0.1 <1",
    owner: "ASafariM Digital",
    runtime: {
      image: id,
      port: 3000,
      health: { live: "/healthz", ready: "/readyz" },
      resources: { memory: "128m", cpus: 0.25 },
    },
    database: { engine: "none" },
    auth: { client: "oidc", publicPaths: [] },
    permissions: [{ key: `${id}.read`, description: "read" }],
    roles: [{ key: `${id}.viewer`, grants: [`${id}.read`] }],
    ...(publishes || subscribes.length
      ? {
          events: {
            ...(publishes ? { publishes: [{ type: typeOf(id), schema: "./events/thing.json" }] } : {}),
            ...(subscribes.length
              ? { subscribes: subscribes.map((type) => ({ type, handler: "/internal/events" })) }
              : {}),
          },
        }
      : {}),
    ui: { glyph: "BA", color: "#0f766e", nav: [], status: "active" },
  };
}

const until = async (check: () => Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting");
};

describe.skipIf(!ready)("per-app NATS identities (integration: Postgres + NATS auth callout)", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  let bus: StreamAdmin;
  let callout: AuthCallout | undefined;
  const credentials: Record<string, string> = {};
  const conns: NatsConnection[] = [];
  const pools: pg.Pool[] = [];
  const relays: Relay[] = [];
  const subs: Subscription[] = [];

  const startCallout = async () => {
    callout = startAuthCallout({
      servers: NATS_URL!,
      user: "core",
      pass: CORE_PASSWORD!,
      issuerSeed: ISSUER_SEED!,
      account: "OS",
      pool,
      log: process.env.DEBUG_DENIED ? (l) => console.log(JSON.stringify(l)) : undefined,
    });
    await callout.served;
  };
  const stopCallout = async () => {
    await callout?.stop();
    callout = undefined;
  };

  const asApp = async (id: string) => {
    const nc = await connect({
      servers: NATS_URL!,
      user: id,
      pass: signNatsConnect({ appId: id, credential: credentials[id]! }),
      inboxPrefix: natsInboxPrefix(id),
      timeout: 3000,
      maxReconnectAttempts: 0,
    });
    conns.push(nc);
    watch(nc);
    return nc;
  };
  const authFor = (id: string) => ({
    user: id,
    pass: () => signNatsConnect({ appId: id, credential: credentials[id]! }),
    inboxPrefix: natsInboxPrefix(id),
  });

  const post = (path: string, body: object, headers: Record<string, string>) =>
    fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const install = async (id: string, publishes: boolean, subscribes: string[] = []) => {
    const res = await post(`/admin/v1/apps/${id}/install`, manifest(id, publishes, subscribes), {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "content-type": "application/json",
    });
    expect(res.status).toBe(201);
    credentials[id] = ((await res.json()) as { credential: string }).credential;
  };

  /**
   * Permission violations the server reported on each connection (they arrive as status events; a
   * denied request also ends in "no responders" or a timeout, which alone could mean "no such consumer").
   */
  const violations = new WeakMap<NatsConnection, string[]>();
  const watch = (nc: NatsConnection) => {
    const seen: string[] = [];
    violations.set(nc, seen);
    void (async () => {
      for await (const s of nc.status()) if (s.type === "error") seen.push(String(s.error?.message ?? s.error));
    })();
  };

  /** The operation fails AND the server says it was a permissions violation on this connection. */
  const denied = async (nc: NatsConnection, op: () => Promise<unknown>) => {
    const before = violations.get(nc)!.length;
    const err = await op().then(
      () => undefined,
      (e: Error) => e,
    );
    if (process.env.DEBUG_DENIED) console.log("denied:", err?.message, violations.get(nc));
    if (!/permissions? violation/i.test(String(err?.message ?? ""))) {
      await until(async () => violations.get(nc)!.length > before, 3000);
    }
    expect(err === undefined, "the operation should have failed").toBe(false);
    expect(violations.get(nc)!.slice(before).join("\n") + String(err?.message ?? "")).toMatch(
      /permissions? violation/i,
    );
  };

  const newDb = async (name: string) => {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${name}`;
    const p = new pg.Pool({ connectionString: url.href, max: 3 });
    p.on("error", () => undefined);
    pools.push(p);
    return p;
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${coreDb}"`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${coreDb}`;
    pool = new pg.Pool({ connectionString: url.href, max: 6 });
    pool.on("error", () => undefined);
    await migrate(pool);
    bus = createStreamAdmin({ servers: NATS_URL!, user: "core", pass: CORE_PASSWORD });
    const registry = createRegistry({
      pool,
      bus,
      provisioner: async () => {
        throw new Error("these apps have no database");
      },
      appDatabaseHost: { host: "127.0.0.1", port: 5432 },
    });
    server = createServer(createHandler({ registry, pool, adminToken: ADMIN_TOKEN, log: () => {} }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await startCallout();
    await install(A, true);
    await install(B, true);
    await install(S, false, [typeOf(A)]);
    await install(U, false);
  });

  afterAll(async () => {
    for (const s of subs.splice(0)) await s.stop();
    for (const r of relays.splice(0)) await r.stop();
    for (const c of conns.splice(0)) await c.close().catch(() => undefined);
    await stopCallout();
    const nc = await connect({ servers: NATS_URL!, user: "core", pass: CORE_PASSWORD });
    const jsm = await jetstreamManager(nc);
    for (const id of [A, B]) await jsm.streams.delete(streamName(id)).catch(() => undefined);
    await nc.close();
    await bus?.close();
    server?.close();
    for (const p of pools) await p.end();
    await pool?.end();
    if (admin) {
      for (const db of [coreDb, pubDb, subDb]) await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it("refuses an anonymous connect, a wrong password and a forged assertion", async () => {
    await expect(connect({ servers: NATS_URL!, timeout: 3000, maxReconnectAttempts: 0 })).rejects.toThrow();
    await expect(
      connect({ servers: NATS_URL!, user: A, pass: "nope", timeout: 3000, maxReconnectAttempts: 0 }),
    ).rejects.toThrow();
    // B's credential cannot sign in as A.
    await expect(
      connect({
        servers: NATS_URL!,
        user: A,
        pass: signNatsConnect({ appId: B, credential: credentials[B]! }),
        timeout: 3000,
        maxReconnectAttempts: 0,
      }),
    ).rejects.toThrow();
  });

  it("refuses a replayed assertion", async () => {
    const pass = signNatsConnect({ appId: A, credential: credentials[A]! });
    const first = await connect({ servers: NATS_URL!, user: A, pass, timeout: 3000, maxReconnectAttempts: 0 });
    await first.close();
    await expect(
      connect({ servers: NATS_URL!, user: A, pass, timeout: 3000, maxReconnectAttempts: 0 }),
    ).rejects.toThrow();
  });

  it("lets app A publish A.x but not B.x", async () => {
    const nc = await asApp(A);
    const js = jetstream(nc);
    const ack = await js.publish(typeOf(A), enc.encode("{}"), { msgID: `ok-${run}` });
    expect(ack.stream).toBe(streamName(A));
    await denied(nc, () => js.publish(typeOf(B), enc.encode("{}"), { msgID: `no-${run}` }));
    await denied(nc, () => js.publish(`${B}.other.thing.v1`, enc.encode("{}")));
  });

  it("keeps app A out of B's durable: no pull, no ack, and it can't create streams or consumers", async () => {
    // S's consumer on A's stream exists (core-api created it at install). B and A aren't allowed near it.
    const stream = streamName(A);
    const consumer = consumerName(S, typeOf(A));
    const nc = await asApp(B);
    await denied(nc, () =>
      nc.request(`$JS.API.CONSUMER.MSG.NEXT.${stream}.${consumer}`, enc.encode("{}"), { timeout: 1000 }),
    );
    await denied(nc, () => jetstream(nc).consumers.get(stream, consumer));
    await denied(nc, async () => {
      nc.publish(`$JS.ACK.${stream}.${consumer}.1.1.1.1.1`);
      await nc.flush();
      throw new Error("ack sent"); // the violation arrives asynchronously, as a status event
    });
    const jsm = await jetstreamManager(nc, { checkAPI: false }); // the account-info probe is itself denied
    await denied(nc, () => jsm.streams.add({ name: "EVIL", subjects: ["evil.>"] }));
    await denied(nc, () => jsm.consumers.add(stream, { durable_name: "evil", filter_subject: typeOf(A) }));
    await denied(nc, () => jsm.streams.delete(stream));
  });

  it("gives each app its own inbox: B can't subscribe to _INBOX.> or S's inbox, and sees nothing S pulls", async () => {
    const spy = await asApp(B);
    const leaked: string[] = [];
    await denied(spy, async () => {
      spy.subscribe("_INBOX.>");
      await spy.flush();
      throw new Error("subscribed"); // the violation arrives asynchronously, as a status event
    });
    await denied(spy, async () => {
      spy.subscribe(`${natsInboxPrefix(S)}.>`);
      await spy.flush();
      throw new Error("subscribed");
    });
    // Its own inbox is allowed.
    spy.subscribe(`${natsInboxPrefix(B)}.>`, {
      callback: (_err, m) => {
        leaked.push(m.subject);
      },
    });
    await spy.flush();

    // S pulls and acks an event of A's while B listens.
    const inboxPool = await newDb(`natsauth_inbox_${run}`);
    await inboxPool.query(INBOX_SQL);
    let handled = 0;
    subs.push(
      subscribe(
        typeOf(A),
        async () => {
          handled++;
        },
        {
          appId: S,
          pool: inboxPool,
          servers: NATS_URL!,
          auth: authFor(S),
          backoff: { initialMs: 50, maxMs: 200 },
          log: { info: () => undefined, warn: () => undefined },
        },
      ),
    );
    await new Promise((r) => setTimeout(r, 800)); // let the consumer start pulling
    const event = createEvent({ source: A, type: typeOf(A), data: { for: "S" }, subject: "t-inbox" });
    await jetstream(await asApp(A)).publish(typeOf(A), enc.encode(JSON.stringify(event)), { msgID: event.id });
    await until(async () => handled > 0);
    expect(handled).toBe(1);
    await new Promise((r) => setTimeout(r, 500));
    expect(leaked).toEqual([]);
    await subs.pop()!.stop(); // S's durable is shared with the next test's subscriber
  });

  it("delivers outbox → relay → subscriber exactly once, each side on its own identity", async () => {
    const pubPool = await newDb(pubDb);
    await pubPool.query(OUTBOX_SQL);
    const subPool = await newDb(subDb);
    await subPool.query(INBOX_SQL);
    await subPool.query("CREATE TABLE received (event_id text PRIMARY KEY)");

    let calls = 0;
    subs.push(
      subscribe(
        typeOf(A),
        async (event, tx) => {
          calls++;
          await tx.query("INSERT INTO received (event_id) VALUES ($1)", [event.id]);
        },
        { appId: S, pool: subPool, servers: NATS_URL!, auth: authFor(S) },
      ),
    );
    relays.push(startRelay({ appId: A, pool: pubPool, servers: NATS_URL!, auth: authFor(A) }));

    const event = createEvent({ source: A, type: typeOf(A), data: { n: 1 }, subject: "t-1" });
    await pubPool.query("INSERT INTO asafarim_outbox (id, type, envelope) VALUES ($1, $2, $3)", [
      event.id,
      event.type,
      JSON.stringify(event),
    ]);
    await until(
      async () => (await subPool.query("SELECT 1 FROM received WHERE event_id = $1", [event.id])).rowCount === 1,
    );
    await new Promise((r) => setTimeout(r, 500)); // a duplicate would have arrived by now
    expect(calls).toBe(1);
    expect(
      (await pubPool.query("SELECT sent_at FROM asafarim_outbox WHERE id = $1", [event.id])).rows[0].sent_at,
    ).not.toBeNull();
  });

  it("an upgrade that adds a subscription: after a reconnect the app can pull from the new durable", async () => {
    const stream = streamName(B);
    const consumer = consumerName(U, typeOf(B));
    const before = await asApp(U); // connected under the OLD manifest (no events at all)
    // An app with no events may not publish anything: an empty allow list would mean "everything" to NATS.
    await denied(before, () => jetstream(before).publish(typeOf(A), enc.encode("{}"), { msgID: `quiet-${run}` }));

    // The app's signed self-registration with a manifest that now subscribes to B's type.
    const body = JSON.stringify(manifest(U, false, [typeOf(B)]));
    const res = await fetch(`${base}/registry/v1/apps/${U}`, {
      method: "POST",
      headers: signRegistration({ appId: U, credential: credentials[U]!, body }),
      body,
    });
    expect(res.status).toBeLessThan(300);

    // Publish after the consumer exists (deliver policy: new), as B.
    const publisher = await asApp(B);
    await jetstream(publisher).publish(typeOf(B), enc.encode('{"after":"upgrade"}'), { msgID: `up-${run}` });

    // The live connection keeps the permissions it was given at connect (known limitation) ...
    await denied(before, () =>
      before.request(`$JS.API.CONSUMER.MSG.NEXT.${stream}.${consumer}`, enc.encode("{}"), { timeout: 1000 }),
    );
    // ... a new connect reads the CURRENT registry row.
    const after = await asApp(U);
    const c = await jetstream(after).consumers.get(stream, consumer);
    const msg = await c.next({ expires: 5000 });
    expect(msg?.string()).toBe('{"after":"upgrade"}');
    msg?.ack();
  });

  it("core-api down: connects fail with an error, the relay keeps the event in the outbox, and it goes out when core-api is back", async () => {
    const pubPool = pools.find((p) => p.options.connectionString?.includes(pubDb))!;
    for (const r of relays.splice(0)) await r.stop();
    await stopCallout();

    await expect(
      connect({
        servers: NATS_URL!,
        user: A,
        pass: signNatsConnect({ appId: A, credential: credentials[A]! }),
        timeout: 2000,
        maxReconnectAttempts: 0,
      }),
    ).rejects.toThrow();

    const warnings: string[] = [];
    const relay = startRelay({
      appId: A,
      pool: pubPool,
      servers: NATS_URL!,
      auth: authFor(A),
      backoff: { initialMs: 200, maxMs: 500 },
      log: { info: () => undefined, warn: (msg) => warnings.push(msg) },
    });
    relays.push(relay);
    const event = createEvent({ source: A, type: typeOf(A), data: { n: 2 }, subject: "t-2" });
    await pubPool.query("INSERT INTO asafarim_outbox (id, type, envelope) VALUES ($1, $2, $3)", [
      event.id,
      event.type,
      JSON.stringify(event),
    ]);
    await until(async () => warnings.includes("events.relay.failed"));
    const row = (await pubPool.query("SELECT sent_at FROM asafarim_outbox WHERE id = $1", [event.id])).rows[0];
    expect(row.sent_at).toBeNull(); // not lost, still waiting

    await startCallout();
    await until(
      async () =>
        (await pubPool.query("SELECT sent_at FROM asafarim_outbox WHERE id = $1", [event.id])).rows[0].sent_at !== null,
      20_000,
    );
  });
});
