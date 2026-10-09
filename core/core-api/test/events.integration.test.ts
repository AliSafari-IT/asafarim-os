/**
 * P4.1: installing an app that declares `events.publishes` creates its JetStream stream
 * (APP_<ID> on <id>.>), over HTTP against a real Postgres and, for the stream itself, a real NATS.
 *
 * Needs CORE_API_TEST_ADMIN_URL (see registry.integration.test.ts); the stream test also needs
 * CORE_API_TEST_NATS_URL (e.g. nats://127.0.0.1:54222 from `pnpm dev`). Each is skipped without
 * its variable, except when CORE_API_TEST_REQUIRED is set (CI), where it fails instead.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createStreamAdmin, streamName, type StreamAdmin } from "@asafarim/events";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const ADMIN_TOKEN = "t".repeat(40);

function manifest(id: string, publishes = true) {
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
    ...(publishes
      ? { events: { publishes: [{ type: `${id}.thing.created.v1`, schema: "./events/thing.json" }] } }
      : {}),
    ui: { glyph: "EV", color: "#7c3aed", nav: [], status: "active" },
  };
}

describe.skipIf(!ADMIN_URL)("core-api install creates the app's event stream (P4.1)", () => {
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

  const install = (base: string, id: string, publishes = true) =>
    fetch(`${base}/admin/v1/apps/${id}/install`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(manifest(id, publishes)),
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
      await (await jetstreamManager(nc)).streams.delete(streamName(PUB)).catch(() => undefined);
      await nc.close();
    }
    await busAdmin?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${coreDb}"`);
      for (const id of [PUB, DOWN, NOBUS, QUIET]) {
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
    });
    const res = await install(base, DOWN);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("bus_unavailable");
    expect((await pool.query("SELECT 1 FROM apps WHERE id = $1", [DOWN])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM app_credentials WHERE app_id = $1", [DOWN])).rowCount).toBe(0);

    const calls: string[] = [];
    const retry = await coreApi({
      ensureAppStream: async (id) => {
        calls.push(id);
        return { stream: streamName(id), result: "created" };
      },
    });
    expect((await install(retry, DOWN)).status).toBe(201);
    expect(calls).toEqual([DOWN]);
  });

  it("no bus configured: the install goes through and is recorded as stream no_bus", async () => {
    const base = await coreApi(undefined);
    expect((await install(base, NOBUS)).status).toBe(201);
    expect(await auditStream(NOBUS)).toEqual(["no_bus"]);
  });

  it("an app that publishes nothing gets no stream, even with a bus", async () => {
    const calls: string[] = [];
    const base = await coreApi({
      ensureAppStream: async (id) => {
        calls.push(id);
        return { stream: streamName(id), result: "created" };
      },
    });
    expect((await install(base, QUIET, false)).status).toBe(201);
    expect(calls).toEqual([]);
    expect(await auditStream(QUIET)).toEqual(["none"]);
  });
});
