/**
 * P4.1: installing an app that declares `events.publishes` creates its JetStream stream
 * (APP_<ID> on <id>.>), and one that declares `events.subscribes` gets a durable consumer per type
 * on the publisher's stream; re-registering (an upgrade) does the same for what the new manifest
 * adds. Over HTTP against a real Postgres and, for the stream and consumers themselves, a real NATS.
 *
 * Needs CORE_API_TEST_ADMIN_URL (see registry.integration.test.ts); the stream test also needs
 * CORE_API_TEST_NATS_URL (e.g. nats://127.0.0.1:54222 from `pnpm dev`). Each is skipped without
 * its variable, except when CORE_API_TEST_REQUIRED is set (CI), where it fails instead.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { consumerName, createStreamAdmin, streamName, type StreamAdmin } from "@asafarim/events";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signRegistration } from "../src/credentials.ts";
import { migrate } from "../src/migrate.ts";
import { appDatabaseNames } from "../src/provision.ts";
import { createRegistry, type RegistryDeps } from "../src/registry.ts";
import { createHandler } from "../src/server.ts";

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
const PUB_TYPE = `${PUB}.thing.created.v1`;
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

describe.skipIf(!ADMIN_URL)(
  "core-api sets up the event stream and durable consumers at install and registration (P4.1)",
  () => {
    let admin: pg.Client;
    let pool: pg.Pool;
    const servers: Server[] = [];
    let busAdmin: StreamAdmin | undefined;

    /** A core-api over HTTP with the given bus; returns its base URL. */
    async function coreApi(bus: RegistryDeps["bus"]) {
      const registry = createRegistry({
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

    const install = (base: string, id: string, publishes = true, subscribes: string[] = []) =>
      fetch(`${base}/admin/v1/apps/${id}/install`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(manifest(id, publishes, subscribes)),
      });

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
      for (const s of servers) s.close();
      if (NATS_URL) {
        const nc = await connect({ servers: NATS_URL });
        const jsm = await jetstreamManager(nc);
        for (const id of [PUB, UPPUB]) await jsm.streams.delete(streamName(id)).catch(() => undefined); // consumers go with them
        await nc.close();
      }
      await busAdmin?.close();
      await pool?.end();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS "${coreDb}"`);
        for (const id of [PUB, DOWN, NOBUS, QUIET, SUB, ORPHAN, UPPUB, UPSUB, `${QUIET}x`]) {
          await admin.query(`DROP ROLE IF EXISTS "${appDatabaseNames(id).role}"`);
        }
        await admin.end();
      }
    });

    it.skipIf(!NATS_URL)(
      "creates APP_<ID> on <id>.> in JetStream and records it in the install's audit event",
      async () => {
        busAdmin = createStreamAdmin({ servers: NATS_URL! });
        const base = await coreApi(busAdmin);
        const res = await install(base, PUB);
        expect(res.status).toBe(201);

        const nc = await connect({ servers: NATS_URL! });
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
        busAdmin ??= createStreamAdmin({ servers: NATS_URL! });
        const base = await coreApi(busAdmin);
        expect((await install(base, SUB, false, [PUB_TYPE])).status).toBe(201); // PUB's stream exists (test 1)
        expect((await install(base, ORPHAN, false, [`nobody${run}.thing.created.v1`])).status).toBe(201);

        const nc = await connect({ servers: NATS_URL! });
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
          { stream: "none", consumers: { [`nobody${run}.thing.created.v1`]: "no_stream" } },
        ]);
      },
    );

    it.skipIf(!NATS_URL)(
      "upgrade: an installed app whose re-registered manifest gains events.publishes gets its stream (idempotent on the next boot)",
      async () => {
        busAdmin ??= createStreamAdmin({ servers: NATS_URL! });
        const base = await coreApi(busAdmin);
        const res = await install(base, UPPUB, false);
        expect(res.status).toBe(201);
        const { credential } = (await res.json()) as { credential: string };
        const nc = await connect({ servers: NATS_URL! });
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
        busAdmin ??= createStreamAdmin({ servers: NATS_URL! });
        const base = await coreApi(busAdmin);
        const res = await install(base, UPSUB, false);
        const { credential } = (await res.json()) as { credential: string };
        const nc = await connect({ servers: NATS_URL! });
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
  },
);
