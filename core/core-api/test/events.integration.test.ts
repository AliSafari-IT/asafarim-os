/**
 * P4.1: installing an app that declares `events.publishes` creates its JetStream stream
 * (APP_<ID> on <id>.>), and one that declares `events.subscribes` gets a durable consumer per type
 * on the publisher's stream; re-registering (an upgrade) does the same for what the new manifest
 * adds. P4.1 PR 3: any install order (a subscriber installed before its publisher is
 * `waiting_for_publisher`, and gets its consumer when the publisher is installed), and an upgrade
 * that drops a subscription deletes its consumer. Over HTTP against a real Postgres and, for the
 * stream and consumers themselves, a real NATS.
 *
 * Needs CORE_API_TEST_ADMIN_URL (see registry.integration.test.ts); the stream test also needs
 * CORE_API_TEST_NATS_URL (e.g. nats://127.0.0.1:54222 from `pnpm dev`). Each is skipped without
 * its variable, except when CORE_API_TEST_REQUIRED is set (CI), where it fails instead.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  INBOX_SQL,
  consumerName,
  createEvent,
  createStreamAdmin,
  streamName,
  subscribe,
  type StreamAdmin,
  type Subscription,
} from "@asafarim/events";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signRegistration } from "../src/credentials.ts";
import { migrate } from "../src/migrate.ts";
import { appDatabaseNames } from "../src/provision.ts";
import { createRegistry, type RegistryDeps } from "../src/registry.ts";
import { createHandler } from "../src/server.ts";

/** The bus checks every client (P4.1 PR 4): the tests sign in as core-api's own `core` user (NATS_CORE_PASSWORD, from .dev/nats.env). */
const NATS_AUTH = process.env.NATS_CORE_PASSWORD ? { user: "core", pass: process.env.NATS_CORE_PASSWORD } : {};
const BUS_AUTH = process.env.NATS_CORE_PASSWORD
  ? { auth: { user: "core", pass: () => process.env.NATS_CORE_PASSWORD! } }
  : {};

const ADMIN_URL = process.env.CORE_API_TEST_ADMIN_URL;
const NATS_URL = process.env.CORE_API_TEST_NATS_URL;
if (process.env.CORE_API_TEST_REQUIRED && (!ADMIN_URL || !NATS_URL)) {
  throw new Error("CORE_API_TEST_ADMIN_URL and CORE_API_TEST_NATS_URL must be set");
}

const run = Date.now().toString(36);
const coreDb = `core_events_test_${run}`;
const PUB = `pub${run}`; // publishes, real bus
const DOWN = `down${run}`; // publishes, the bus refuses
const NOBUS = `nobus${run}`; // publishes, no bus configured
const QUIET = `quiet${run}`; // publishes nothing
const SUB = `sub${run}`; // subscribes to PUB's type at install, real bus
const ORPHAN = `orphan${run}`; // subscribes to a type nobody publishes (no stream)
const UPPUB = `uppub${run}`; // installed quiet, re-registers publishing
const UPSUB = `upsub${run}`; // installed quiet, re-registers subscribing to PUB's type
const EARLYSUB = `esub${run}`; // installed BEFORE its publisher (EARLYPUB)
const EARLYPUB = `epub${run}`;
const DROPSUB = `dsub${run}`; // subscribes to PUB's and EARLYPUB's types, an upgrade drops EARLYPUB's
const FAKESUB = `fsub${run}`; // fake bus: subscriber first, then FAKEPUB
const FAKEPUB = `fpub${run}`;
const FAILPUB = `xpub${run}`; // publisher whose waiting subscriber's consumer can't be created
const FAILSUB = `xsub${run}`;
const FAILDROP = `xdrop${run}`;
const DPUB = `dpub${run}`; // publishes two types; an upgrade drops one, a later one re-adds it (real bus)
const DS1 = `dsa${run}`; // subscribes to both of DPUB's types
const DS2 = `dsb${run}`; // subscribes to the dropped type only
const FPUB2 = `fpubb${run}`; // fake bus: publisher of two types for the keep / not-installed / bus-down cases
const FSUB2 = `fsubb${run}`;
const XPUB2 = `xpubb${run}`; // the bus fails while an upgrade deletes the consumers of a type it stops publishing
const XSUB2 = `xsubb${run}`;
const BUSY = `busy${run}`; // waits for the plumbing lock another install holds // an upgrade drops a subscription and the delete fails
const PUB_TYPE = `${PUB}.thing.created.v1`;
const typeOf = (id: string) => `${id}.thing.created.v1`;
const deletedOf = (id: string) => `${id}.thing.deleted.v1`;
const subDb = `core_events_sub_${run}`;
const ADMIN_TOKEN = "t".repeat(40);

function manifest(id: string, publishes = true, subscribes: string[] = []) {
  return {
    id,
    name: "Events test",
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
            ...(publishes ? { publishes: [{ type: `${id}.thing.created.v1`, schema: "./events/thing.json" }] } : {}),
            ...(subscribes.length
              ? { subscribes: subscribes.map((type) => ({ type, handler: "/internal/events" })) }
              : {}),
          },
        }
      : {}),
    ui: { glyph: "EV", color: "#7c3aed", nav: [], status: "active" },
  };
}

/** A manifest that publishes and subscribes to exactly the given types. */
function manifestWith(id: string, publishes: string[], subscribes: string[] = []) {
  return {
    ...manifest(id, false),
    events: {
      publishes: publishes.map((type) => ({ type, schema: "./events/thing.json" })),
      subscribes: subscribes.map((type) => ({ type, handler: "/internal/events" })),
    },
  };
}

describe.skipIf(!ADMIN_URL)(
  "core-api sets up the event stream and durable consumers at install and registration (P4.1)",
  () => {
    let admin: pg.Client;
    let pool: pg.Pool;
    const servers: Server[] = [];
    let busAdmin: StreamAdmin | undefined;
    let subPool: pg.Pool | undefined;
    const subs: Subscription[] = [];

    /** A core-api over HTTP with the given bus; returns its base URL. */
    async function coreApi(bus: RegistryDeps["bus"], extra: Partial<RegistryDeps> = {}) {
      const registry = createRegistry({
        ...extra,
        pool,
        bus,
        provisioner: async () => {
          throw new Error("these apps have no database");
        },
        appDatabaseHost: { host: "127.0.0.1", port: 5432 },
      });
      const server = createServer(createHandler({ registry, pool, adminToken: ADMIN_TOKEN, log: () => {} }));
      servers.push(server);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    const installManifest = (base: string, id: string, m: object) =>
      fetch(`${base}/admin/v1/apps/${id}/install`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(m),
      });
    const install = (base: string, id: string, publishes = true, subscribes: string[] = []) =>
      installManifest(base, id, manifest(id, publishes, subscribes));

    /** The app's signed self-registration with a (new) manifest: what an upgraded app does on boot. */
    const register = (base: string, id: string, credential: string, m: object) => {
      const body = JSON.stringify(m);
      return fetch(`${base}/registry/v1/apps/${id}`, {
        method: "POST",
        headers: signRegistration({ appId: id, credential, body }),
        body,
      });
    };

    const auditOf = async (id: string, action: string) =>
      (
        await pool.query(
          "SELECT detail->'stream' AS stream, detail->'consumers' AS consumers FROM audit_events WHERE app_id = $1 AND action = $2 ORDER BY id",
          [id, action],
        )
      ).rows;

    /** A fake bus that records what it was asked to do. */
    const recordingBus = (calls: string[]) => ({
      ensureAppStream: async (id: string) => {
        calls.push(`stream:${id}`);
        return { stream: streamName(id), result: "created" };
      },
      ensureConsumer: async (app: string, type: string) => {
        calls.push(`consumer:${app}:${type}`);
        return { consumer: consumerName(app, type), result: "created" };
      },
      deleteConsumer: async (app: string, type: string) => {
        calls.push(`delete:${app}:${type}`);
        return { consumer: consumerName(app, type), result: "deleted" };
      },
      deleteAppStream: async (id: string) => {
        calls.push(`deleteStream:${id}`);
        return { stream: streamName(id), result: "deleted" };
      },
    });

    const auditStream = async (id: string) =>
      (
        await pool.query(
          "SELECT detail->'stream' AS stream FROM audit_events WHERE app_id = $1 AND action = 'app.installed'",
          [id],
        )
      ).rows.map((r) => r.stream);

    beforeAll(async () => {
      admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${coreDb}"`);
      const url = new URL(ADMIN_URL!);
      url.pathname = `/${coreDb}`;
      pool = new pg.Pool({ connectionString: url.href, max: 4 });
      await migrate(pool);
    });

    afterAll(async () => {
      for (const sub of subs.splice(0)) await sub.stop();
      await subPool?.end();
      for (const s of servers) s.close();
      if (NATS_URL) {
        const nc = await connect({ servers: NATS_URL, ...NATS_AUTH });
        const jsm = await jetstreamManager(nc);
        for (const id of [PUB, UPPUB, EARLYPUB, DPUB]) await jsm.streams.delete(streamName(id)).catch(() => undefined); // consumers go with them
        await nc.close();
      }
      await busAdmin?.close();
      await pool?.end();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS "${coreDb}"`);
        await admin.query(`DROP DATABASE IF EXISTS "${subDb}" WITH (FORCE)`);
        for (const id of [
          PUB,
          DOWN,
          NOBUS,
          QUIET,
          SUB,
          ORPHAN,
          UPPUB,
          UPSUB,
          `${QUIET}x`,
          EARLYSUB,
          EARLYPUB,
          DROPSUB,
        ]) {
          await admin.query(`DROP ROLE IF EXISTS "${appDatabaseNames(id).role}"`);
        }
        await admin.end();
      }
    });

    it.skipIf(!NATS_URL)(
      "creates APP_<ID> on <id>.> in JetStream and records it in the install's audit event",
      async () => {
        busAdmin = createStreamAdmin({ servers: NATS_URL!, ...NATS_AUTH });
        const base = await coreApi(busAdmin);
        const res = await install(base, PUB);
        expect(res.status).toBe(201);

        const nc = await connect({ servers: NATS_URL!, ...NATS_AUTH });
        try {
          const info = await (await jetstreamManager(nc)).streams.info(streamName(PUB));
          expect(info.config.name).toBe(`APP_${PUB.toUpperCase()}`);
          expect(info.config.subjects).toEqual([`${PUB}.>`]);
          expect(info.config.storage).toBe("file");
        } finally {
          await nc.close();
        }
        expect(await auditStream(PUB)).toEqual([{ stream: streamName(PUB), result: "created" }]);
      },
    );

    it("a bus that can't create the stream: 503 bus_unavailable and NOTHING is installed (a retry can succeed)", async () => {
      const base = await coreApi({
        ensureAppStream: async () => {
          throw new Error("connection refused");
        },
        ensureConsumer: async () => {
          throw new Error("connection refused");
        },
        deleteConsumer: async () => {
          throw new Error("connection refused");
        },
        deleteAppStream: async () => {
          throw new Error("connection refused");
        },
      });
      const res = await install(base, DOWN);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("bus_unavailable");
      expect((await pool.query("SELECT 1 FROM apps WHERE id = $1", [DOWN])).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 FROM app_credentials WHERE app_id = $1", [DOWN])).rowCount).toBe(0);

      const calls: string[] = [];
      const retry = await coreApi(recordingBus(calls));
      expect((await install(retry, DOWN)).status).toBe(201);
      expect(calls).toEqual([`stream:${DOWN}`]);
    });

    it("no bus configured: the install goes through and is recorded as stream no_bus", async () => {
      const base = await coreApi(undefined);
      expect((await install(base, NOBUS)).status).toBe(201);
      expect(await auditStream(NOBUS)).toEqual(["no_bus"]);
    });

    it("an app that publishes nothing gets no stream, even with a bus", async () => {
      const calls: string[] = [];
      const base = await coreApi(recordingBus(calls));
      expect((await install(base, QUIET, false)).status).toBe(201);
      expect(calls).toEqual([]);
      expect(await auditStream(QUIET)).toEqual(["none"]);
    });
    it.skipIf(!NATS_URL)(
      "install of a subscriber: a durable consumer <app>.<type> on the publisher's stream; none for a type without a stream",
      async () => {
        busAdmin ??= createStreamAdmin({ servers: NATS_URL!, ...NATS_AUTH });
        const base = await coreApi(busAdmin);
        expect((await install(base, SUB, false, [PUB_TYPE])).status).toBe(201); // PUB's stream exists (test 1)
        expect((await install(base, ORPHAN, false, [`nobody${run}.thing.created.v1`])).status).toBe(201);

        const nc = await connect({ servers: NATS_URL!, ...NATS_AUTH });
        try {
          const jsm = await jetstreamManager(nc);
          const info = await jsm.consumers.info(streamName(PUB), consumerName(SUB, PUB_TYPE));
          expect(info.config).toMatchObject({ filter_subject: PUB_TYPE, ack_policy: "explicit" });
          expect((await jsm.streams.info("DEADLETTER")).config.subjects).toEqual(["deadletter.>"]);
        } finally {
          await nc.close();
        }
        expect(await auditOf(SUB, "app.installed")).toEqual([{ stream: "none", consumers: { [PUB_TYPE]: "created" } }]);
        expect(await auditOf(ORPHAN, "app.installed")).toEqual([
          { stream: "none", consumers: { [`nobody${run}.thing.created.v1`]: "waiting_for_publisher" } },
        ]);
      },
    );

    it.skipIf(!NATS_URL)(
      "upgrade: an installed app whose re-registered manifest gains events.publishes gets its stream (idempotent on the next boot)",
      async () => {
        busAdmin ??= createStreamAdmin({ servers: NATS_URL!, ...NATS_AUTH });
        const base = await coreApi(busAdmin);
        const res = await install(base, UPPUB, false);
        expect(res.status).toBe(201);
        const { credential } = (await res.json()) as { credential: string };
        const nc = await connect({ servers: NATS_URL!, ...NATS_AUTH });
        try {
          const jsm = await jetstreamManager(nc);
          await expect(jsm.streams.info(streamName(UPPUB))).rejects.toThrow(/stream not found/i);

          expect((await register(base, UPPUB, credential, manifest(UPPUB, true))).status).toBe(200);
          const info = await jsm.streams.info(streamName(UPPUB));
          expect(info.config.subjects).toEqual([`${UPPUB}.>`]);
          // The app registers again on every boot: nothing changes.
          expect((await register(base, UPPUB, credential, manifest(UPPUB, true))).status).toBe(200);
        } finally {
          await nc.close();
        }
        expect((await auditOf(UPPUB, "app.registered")).map((r) => r.stream)).toEqual([
          { stream: streamName(UPPUB), result: "created" },
          { stream: streamName(UPPUB), result: "exists" },
        ]);
      },
    );

    it.skipIf(!NATS_URL)(
      "upgrade: an installed app whose re-registered manifest gains events.subscribes gets its durable consumer",
      async () => {
        busAdmin ??= createStreamAdmin({ servers: NATS_URL!, ...NATS_AUTH });
        const base = await coreApi(busAdmin);
        const res = await install(base, UPSUB, false);
        const { credential } = (await res.json()) as { credential: string };
        const nc = await connect({ servers: NATS_URL!, ...NATS_AUTH });
        try {
          const jsm = await jetstreamManager(nc);
          await expect(jsm.consumers.info(streamName(PUB), consumerName(UPSUB, PUB_TYPE))).rejects.toThrow(
            /consumer not found/i,
          );
          expect((await register(base, UPSUB, credential, manifest(UPSUB, false, [PUB_TYPE]))).status).toBe(200);
          const info = await jsm.consumers.info(streamName(PUB), consumerName(UPSUB, PUB_TYPE));
          expect(info.config).toMatchObject({ durable_name: consumerName(UPSUB, PUB_TYPE), filter_subject: PUB_TYPE });
        } finally {
          await nc.close();
        }
        expect((await auditOf(UPSUB, "app.registered")).map((r) => r.consumers)).toEqual([{ [PUB_TYPE]: "created" }]);
        const subs = await pool.query("SELECT event_type FROM event_subscriptions WHERE app_id = $1", [UPSUB]);
        expect(subs.rows).toEqual([{ event_type: PUB_TYPE }]);
      },
    );

    it("registration with a bus that fails: 503 bus_unavailable and nothing is written; no bus: recorded as no_bus", async () => {
      const id = QUIET; // installed in an earlier test, publishes nothing yet
      const fake = await coreApi(recordingBus([]));
      const cred = (await (await install(fake, `${id}x`, false)).json()) as { credential: string };
      const down = await coreApi({
        ensureAppStream: async () => {
          throw new Error("connection refused");
        },
        ensureConsumer: async () => {
          throw new Error("connection refused");
        },
        deleteConsumer: async () => {
          throw new Error("connection refused");
        },
        deleteAppStream: async () => {
          throw new Error("connection refused");
        },
      });
      const before = await auditOf(`${id}x`, "app.registered");
      const res = await register(down, `${id}x`, cred.credential, manifest(`${id}x`, true));
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("bus_unavailable");
      expect(await auditOf(`${id}x`, "app.registered")).toEqual(before);
      const version = await pool.query("SELECT manifest->'events' AS events FROM apps WHERE id = $1", [`${id}x`]);
      expect(version.rows[0].events).toBeNull(); // the old manifest stays

      const nobus = await coreApi(undefined);
      expect((await register(nobus, `${id}x`, cred.credential, manifest(`${id}x`, true, [PUB_TYPE]))).status).toBe(200);
      expect(await auditOf(`${id}x`, "app.registered")).toEqual([{ stream: "no_bus", consumers: "no_bus" }]);
    });

    const json = async <T>(res: Response) => (await res.json()) as T;
    type Events = {
      stream: unknown;
      consumers: unknown;
      removedConsumers: unknown;
      dependentConsumers: unknown;
      orphanedConsumers: unknown;
      warnings: { app?: string; type: string; code: string }[];
    };

    /** What the Admin console shows for the app: the types still waiting for their publisher. */
    const waitingInAdmin = async (base: string, id: string) => {
      const res = await fetch(`${base}/admin/v1/apps`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
      const { apps } = await json<{ apps: { id: string; waitingForPublisher: string[] }[] }>(res);
      return apps.find((a) => a.id === id)?.waitingForPublisher;
    };

    /** A subscriber process for `app` on `type` in the test inbox database; counts handler runs. */
    async function startSubscriber(app: string, type: string) {
      if (!subPool) {
        await admin.query(`CREATE DATABASE "${subDb}"`);
        const url = new URL(ADMIN_URL!);
        url.pathname = `/${subDb}`;
        subPool = new pg.Pool({ connectionString: url.href, max: 3 });
        subPool.on("error", () => undefined);
        await subPool.query(INBOX_SQL);
      }
      const seen: string[] = [];
      const sub = subscribe(
        type,
        async (event) => {
          seen.push(event.id);
        },
        {
          appId: app,
          pool: subPool,
          servers: NATS_URL!,
          ...BUS_AUTH,
          backoff: { initialMs: 50, maxMs: 200 },
          log: { info: () => undefined, warn: () => undefined },
        },
      );
      subs.push(sub);
      return seen;
    }

    /** Publish one event of `type` the way the publisher's relay does. */
    async function publishOne(publisher: string, type: string) {
      const nc = await connect({ servers: NATS_URL!, ...NATS_AUTH });
      try {
        const event = createEvent({ source: publisher, type, data: { n: 1 }, subject: "thing-1" });
        await jetstream(nc).publish(type, new TextEncoder().encode(JSON.stringify(event)), { msgID: event.id });
        return event.id;
      } finally {
        await nc.close();
      }
    }

    it.skipIf(!NATS_URL)(
      "any install order: subscriber first → waiting_for_publisher (and an Admin warning); publisher installed → the subscriber's consumer exists; one event → its handler runs exactly once",
      async () => {
        busAdmin ??= createStreamAdmin({ servers: NATS_URL!, ...NATS_AUTH });
        const base = await coreApi(busAdmin);
        const TYPE = typeOf(EARLYPUB);

        const subRes = await install(base, EARLYSUB, false, [TYPE]);
        expect(subRes.status).toBe(201);
        const subEvents = (await json<{ events: Events }>(subRes)).events;
        expect(subEvents.consumers).toEqual({ [TYPE]: "waiting_for_publisher" });
        expect(subEvents.warnings).toEqual([{ type: TYPE, code: "waiting_for_publisher" }]);
        expect(await auditOf(EARLYSUB, "app.installed")).toEqual([
          { stream: "none", consumers: { [TYPE]: "waiting_for_publisher" } },
        ]);
        expect(await waitingInAdmin(base, EARLYSUB)).toEqual([TYPE]);

        const pubRes = await install(base, EARLYPUB);
        expect(pubRes.status).toBe(201);
        const pubEvents = (await json<{ events: Events }>(pubRes)).events;
        expect(pubEvents.stream).toEqual({ stream: streamName(EARLYPUB), result: "created" });
        expect(pubEvents.dependentConsumers).toEqual({ [EARLYSUB]: { [TYPE]: "created" } });
        expect(pubEvents.warnings).toEqual([]);
        const audit = await pool.query(
          "SELECT detail->'dependentConsumers' AS d FROM audit_events WHERE app_id = $1 AND action = 'app.installed'",
          [EARLYPUB],
        );
        expect(audit.rows).toEqual([{ d: { [EARLYSUB]: { [TYPE]: "created" } } }]);
        expect(await waitingInAdmin(base, EARLYSUB)).toEqual([]);

        const nc = await connect({ servers: NATS_URL!, ...NATS_AUTH });
        try {
          const info = await (
            await jetstreamManager(nc)
          ).consumers.info(streamName(EARLYPUB), consumerName(EARLYSUB, TYPE));
          expect(info.config).toMatchObject({ filter_subject: TYPE, ack_policy: "explicit", deliver_policy: "new" });
        } finally {
          await nc.close();
        }

        const seen = await startSubscriber(EARLYSUB, TYPE);
        const id = await publishOne(EARLYPUB, TYPE);
        await expect.poll(() => seen.length, { timeout: 15_000 }).toBe(1);
        await new Promise((r) => setTimeout(r, 1000));
        expect(seen).toEqual([id]); // exactly once
      },
      30_000,
    );

    it.skipIf(!NATS_URL)(
      "upgrade that drops a subscription: its consumer is deleted, the remaining one still delivers",
      async () => {
        busAdmin ??= createStreamAdmin({ servers: NATS_URL!, ...NATS_AUTH });
        const base = await coreApi(busAdmin);
        const KEEP = PUB_TYPE; // PUB's stream: test 1
        const DROP = typeOf(EARLYPUB); // EARLYPUB's stream: the install-order test
        const res = await install(base, DROPSUB, false, [KEEP, DROP]);
        expect(res.status).toBe(201);
        const { credential } = await json<{ credential: string }>(res);
        expect((await register(base, DROPSUB, credential, manifest(DROPSUB, false, [KEEP, DROP]))).status).toBe(200);

        const nc = await connect({ servers: NATS_URL!, ...NATS_AUTH });
        try {
          const jsm = await jetstreamManager(nc);
          await jsm.consumers.info(streamName(EARLYPUB), consumerName(DROPSUB, DROP)); // exists

          const up = await register(base, DROPSUB, credential, manifest(DROPSUB, false, [KEEP]));
          expect(up.status).toBe(200);
          const events = (await json<{ events: Events }>(up)).events;
          expect(events.consumers).toEqual({ [KEEP]: "exists" });
          expect(events.removedConsumers).toEqual({ [DROP]: "deleted" });
          await expect(jsm.consumers.info(streamName(EARLYPUB), consumerName(DROPSUB, DROP))).rejects.toThrow(
            /consumer not found/i,
          );
          await jsm.consumers.info(streamName(PUB), consumerName(DROPSUB, KEEP)); // still there
          // The next boot registers the same manifest: nothing left to remove.
          const again = await register(base, DROPSUB, credential, manifest(DROPSUB, false, [KEEP]));
          expect((await json<{ events: Events }>(again)).events.removedConsumers).toBe("none");
        } finally {
          await nc.close();
        }
        const subsNow = await pool.query("SELECT event_type FROM event_subscriptions WHERE app_id = $1", [DROPSUB]);
        expect(subsNow.rows).toEqual([{ event_type: KEEP }]);
        const removedAudit = await pool.query(
          "SELECT detail->'removedConsumers' AS r FROM audit_events WHERE app_id = $1 AND action = 'app.registered' ORDER BY id",
          [DROPSUB],
        );
        expect(removedAudit.rows.map((r) => r.r)).toEqual(["none", { [DROP]: "deleted" }, "none"]);

        const seen = await startSubscriber(DROPSUB, KEEP);
        const id = await publishOne(PUB, KEEP);
        await expect.poll(() => seen.length, { timeout: 15_000 }).toBe(1);
        expect(seen).toEqual([id]);
      },
      30_000,
    );

    it("a publisher installed after its subscriber asks the bus for the subscriber's consumer (fake bus)", async () => {
      const calls: string[] = [];
      const bus = {
        ...recordingBus(calls),
        // No stream for FAKEPUB until it is installed.
        ensureConsumer: async (app: string, type: string) => {
          calls.push(`consumer:${app}:${type}`);
          return {
            consumer: consumerName(app, type),
            result: calls.includes(`stream:${FAKEPUB}`) ? "created" : "no_stream",
          };
        },
      };
      const base = await coreApi(bus);
      const sub = await install(base, FAKESUB, false, [typeOf(FAKEPUB)]);
      expect((await json<{ events: Events }>(sub)).events.warnings).toEqual([
        { type: typeOf(FAKEPUB), code: "waiting_for_publisher" },
      ]);
      calls.length = 0;
      expect((await install(base, FAKEPUB)).status).toBe(201);
      expect(calls).toEqual([`stream:${FAKEPUB}`, `consumer:${FAKESUB}:${typeOf(FAKEPUB)}`]);
    });

    it("bus down while a publisher's waiting subscriber gets its consumer: 503 bus_unavailable, nothing installed or audited", async () => {
      const base = await coreApi(recordingBus([]));
      expect((await install(base, FAILSUB, false, [typeOf(FAILPUB)])).status).toBe(201);
      const auditBefore = (await pool.query("SELECT count(*)::int AS n FROM audit_events")).rows[0].n;
      const down = await coreApi({
        ...recordingBus([]),
        ensureConsumer: async () => {
          throw new Error("connection refused");
        },
      });
      const res = await install(down, FAILPUB);
      expect(res.status).toBe(503);
      expect((await json<{ error: string }>(res)).error).toBe("bus_unavailable");
      expect((await pool.query("SELECT 1 FROM apps WHERE id = $1", [FAILPUB])).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 FROM app_credentials WHERE app_id = $1", [FAILPUB])).rowCount).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS n FROM audit_events")).rows[0].n).toBe(auditBefore);
    });

    it("bus down while an upgrade deletes a dropped subscription's consumer: 503 bus_unavailable, manifest, subscriptions and audit unchanged", async () => {
      const ok = await coreApi(recordingBus([]));
      const res = await install(ok, FAILDROP, false, [PUB_TYPE, typeOf(FAILPUB)]);
      const { credential } = await json<{ credential: string }>(res);
      expect(
        (await register(ok, FAILDROP, credential, manifest(FAILDROP, false, [PUB_TYPE, typeOf(FAILPUB)]))).status,
      ).toBe(200);
      const snapshot = async () => ({
        manifest: (await pool.query("SELECT manifest->'events' AS e FROM apps WHERE id = $1", [FAILDROP])).rows,
        subs: (await pool.query("SELECT event_type FROM event_subscriptions WHERE app_id = $1 ORDER BY 1", [FAILDROP]))
          .rows,
        audit: (await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE app_id = $1", [FAILDROP])).rows,
      });
      const before = await snapshot();
      const down = await coreApi({
        ...recordingBus([]),
        deleteConsumer: async () => {
          throw new Error("connection refused");
        },
        deleteAppStream: async () => {
          throw new Error("connection refused");
        },
      });
      const up = await register(down, FAILDROP, credential, manifest(FAILDROP, false, [PUB_TYPE]));
      expect(up.status).toBe(503);
      expect((await json<{ error: string }>(up)).error).toBe("bus_unavailable");
      expect(await snapshot()).toEqual(before);
    });

    it("another install holding the event plumbing lock too long: 503 registry_busy and nothing installed; once it's free, the install goes through", async () => {
      const base = await coreApi(recordingBus([]), { plumbingLockTimeoutMs: 200 });
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(4049100053)"); // the registry's lock
        const res = await install(base, BUSY);
        expect(res.status).toBe(503);
        expect((await json<{ error: string }>(res)).error).toBe("registry_busy");
        expect((await pool.query("SELECT 1 FROM apps WHERE id = $1", [BUSY])).rowCount).toBe(0);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
      expect((await install(base, BUSY)).status).toBe(201);
    });
    it.skipIf(!NATS_URL)(
      "upgrade that stops publishing a type: the other apps' consumers of it are deleted and they wait again; re-adding it re-creates them",
      async () => {
        busAdmin ??= createStreamAdmin({ servers: NATS_URL!, ...NATS_AUTH });
        const base = await coreApi(busAdmin);
        const KEEP = typeOf(DPUB);
        const DROP = deletedOf(DPUB);
        const both = manifestWith(DPUB, [KEEP, DROP]);
        const pubRes = await installManifest(base, DPUB, both);
        expect(pubRes.status).toBe(201);
        const { credential } = await json<{ credential: string }>(pubRes);
        expect((await installManifest(base, DS1, manifestWith(DS1, [], [KEEP, DROP]))).status).toBe(201);
        expect((await installManifest(base, DS2, manifestWith(DS2, [], [DROP]))).status).toBe(201);
        expect((await register(base, DPUB, credential, both)).status).toBe(200);

        const nc = await connect({ servers: NATS_URL!, ...NATS_AUTH });
        try {
          const jsm = await jetstreamManager(nc);
          const consumerOf = (app: string, type: string) =>
            jsm.consumers.info(streamName(DPUB), consumerName(app, type));
          await consumerOf(DS1, DROP);
          // Someone (or an earlier, rolled-back attempt) already deleted DS2's: reported as absent, not an error.
          await jsm.consumers.delete(streamName(DPUB), consumerName(DS2, DROP));

          const up = await register(base, DPUB, credential, manifestWith(DPUB, [KEEP]));
          expect(up.status).toBe(200);
          const events = (await json<{ events: Events }>(up)).events;
          expect(events.orphanedConsumers).toEqual({ [DS1]: { [DROP]: "deleted" }, [DS2]: { [DROP]: "absent" } });
          expect(events.dependentConsumers).toEqual({ [DS1]: { [KEEP]: "exists" } });
          expect(events.warnings).toEqual([
            { app: DS1, type: DROP, code: "waiting_for_publisher" },
            { app: DS2, type: DROP, code: "waiting_for_publisher" },
          ]);
          await expect(consumerOf(DS1, DROP)).rejects.toThrow(/consumer not found/i);
          await expect(consumerOf(DS2, DROP)).rejects.toThrow(/consumer not found/i);
          await consumerOf(DS1, KEEP); // the kept type's consumer stays
          expect(await waitingInAdmin(base, DS1)).toEqual([DROP]);
          expect(await waitingInAdmin(base, DS2)).toEqual([DROP]);
          const audit = await pool.query(
            "SELECT detail->'orphanedConsumers' AS o FROM audit_events WHERE app_id = $1 AND action = 'app.registered' ORDER BY id",
            [DPUB],
          );
          expect(audit.rows.map((r) => r.o)).toEqual([
            "none",
            { [DS1]: { [DROP]: "deleted" }, [DS2]: { [DROP]: "absent" } },
          ]);

          // The next boot registers the same manifest: nothing left to clean up.
          const again = await register(base, DPUB, credential, manifestWith(DPUB, [KEEP]));
          const againEvents = (await json<{ events: Events }>(again)).events;
          expect(againEvents.orphanedConsumers).toBe("none");
          expect(againEvents.warnings).toEqual([]);

          // A later upgrade publishes the type again: the existing dependents path re-creates both consumers.
          const back = await register(base, DPUB, credential, both);
          expect(back.status).toBe(200);
          const backEvents = (await json<{ events: Events }>(back)).events;
          expect(backEvents.dependentConsumers).toEqual({
            [DS1]: { [KEEP]: "exists", [DROP]: "created" },
            [DS2]: { [DROP]: "created" },
          });
          expect(backEvents.orphanedConsumers).toBe("none");
          await consumerOf(DS1, DROP);
          await consumerOf(DS2, DROP);
          expect(await waitingInAdmin(base, DS1)).toEqual([]);
          expect(await waitingInAdmin(base, DS2)).toEqual([]);
        } finally {
          await nc.close();
        }

        const seen = await startSubscriber(DS2, DROP);
        const id = await publishOne(DPUB, DROP);
        await expect.poll(() => seen.length, { timeout: 15_000 }).toBe(1);
        expect(seen).toEqual([id]);
      },
      30_000,
    );

    it("an upgrade that keeps every type, or drops a type nobody installed subscribes to, deletes nothing (fake bus)", async () => {
      const calls: string[] = [];
      const base = await coreApi(recordingBus(calls));
      const A = typeOf(FPUB2);
      const B = deletedOf(FPUB2);
      const res = await installManifest(base, FPUB2, manifestWith(FPUB2, [A, B]));
      const { credential } = await json<{ credential: string }>(res);
      // FSUB2 subscribes to A only; nobody installed subscribes to B (an app that isn't installed can't).
      expect((await installManifest(base, FSUB2, manifestWith(FSUB2, [], [A]))).status).toBe(201);

      calls.length = 0;
      const keep = await register(base, FPUB2, credential, manifestWith(FPUB2, [A, B]));
      expect((await json<{ events: Events }>(keep)).events.orphanedConsumers).toBe("none");
      expect(calls.filter((c) => c.startsWith("delete:"))).toEqual([]);

      calls.length = 0;
      const dropB = await register(base, FPUB2, credential, manifestWith(FPUB2, [A]));
      const events = (await json<{ events: Events }>(dropB)).events;
      expect(events.orphanedConsumers).toBe("none");
      expect(events.warnings).toEqual([]);
      expect(calls.filter((c) => c.startsWith("delete:"))).toEqual([]);
      expect(calls).toEqual([`stream:${FPUB2}`, `consumer:${FSUB2}:${A}`]);
    });

    it("bus down while an upgrade deletes the consumers of a type it stops publishing: 503 bus_unavailable, nothing written", async () => {
      const ok = await coreApi(recordingBus([]));
      const T = typeOf(XPUB2);
      const res = await installManifest(ok, XPUB2, manifestWith(XPUB2, [T]));
      const { credential } = await json<{ credential: string }>(res);
      expect((await installManifest(ok, XSUB2, manifestWith(XSUB2, [], [T]))).status).toBe(201);
      expect((await register(ok, XPUB2, credential, manifestWith(XPUB2, [T]))).status).toBe(200);
      const snapshot = async () => ({
        manifest: (await pool.query("SELECT manifest->'events' AS e FROM apps WHERE id = $1", [XPUB2])).rows,
        audit: (await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE app_id = $1", [XPUB2])).rows,
      });
      const before = await snapshot();
      const down = await coreApi({
        ...recordingBus([]),
        deleteConsumer: async () => {
          throw new Error("connection refused");
        },
        deleteAppStream: async () => {
          throw new Error("connection refused");
        },
      });
      const up = await register(down, XPUB2, credential, manifestWith(XPUB2, []));
      expect(up.status).toBe(503);
      expect((await json<{ error: string }>(up)).error).toBe("bus_unavailable");
      expect(await snapshot()).toEqual(before);

      // Once the bus is back, the same registration goes through.
      const calls: string[] = [];
      const retry = await coreApi(recordingBus(calls));
      const again = await register(retry, XPUB2, credential, manifestWith(XPUB2, []));
      expect(again.status).toBe(200);
      expect((await json<{ events: Events }>(again)).events.orphanedConsumers).toEqual({
        [XSUB2]: { [T]: "deleted" },
      });
      expect(calls).toEqual([`delete:${XSUB2}:${T}`]);
    });
  },
);
