/**
 * #68: the Remove lifecycle step (ADR 0001 §3 step 6) against a real Postgres and a real NATS
 * JetStream, over HTTP:
 *
 *  - removing a publisher deletes its stream (and the messages in it), its subscribers' consumers
 *    (they wait for a publisher again) and its types leave the catalog;
 *  - removing a subscriber deletes its consumers and leaves the publisher's stream alone;
 *  - a removed app can't register or upload schemas, and its grants are gone;
 *  - reinstall + register: a fresh stream, bound consumers, roles and permissions back, no grant
 *    carried over, and nothing from before the removal is delivered;
 *  - a bus failure during remove changes nothing;
 *  - a self-subscribing publisher that stops publishing its type loses its own consumer, stably.
 *
 * Needs CORE_API_TEST_ADMIN_URL and CORE_API_TEST_NATS_URL (see events.integration.test.ts). Skipped
 * without them, except when CORE_API_TEST_REQUIRED is set (CI), where it fails instead.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { consumerName, createStreamAdmin, streamName, type StreamAdmin } from "@asafarim/events";
import { signRequest } from "@asafarim/registry-protocol";
import { jetstream, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signRegistration } from "../src/credentials.ts";
import { migrate } from "../src/migrate.ts";
import { createRegistry, type EventBus } from "../src/registry.ts";
import { createHandler } from "../src/server.ts";

const NATS_AUTH = process.env.NATS_CORE_PASSWORD ? { user: "core", pass: process.env.NATS_CORE_PASSWORD } : {};
const ADMIN_URL = process.env.CORE_API_TEST_ADMIN_URL;
const NATS_URL = process.env.CORE_API_TEST_NATS_URL;
if (process.env.CORE_API_TEST_REQUIRED && (!ADMIN_URL || !NATS_URL)) {
  throw new Error("CORE_API_TEST_ADMIN_URL and CORE_API_TEST_NATS_URL must be set");
}

const run = Date.now().toString(36);
const coreDb = `core_remove_test_${run}`;
const PUB = `rpub${run}`; // publishes; removed, then reinstalled
const SUB = `rsub${run}`; // subscribes to PUB's type
const PUB2 = `rpubb${run}`; // publishes; its subscriber SUB2 is removed
const SUB2 = `rsubb${run}`;
const FAIL = `rfail${run}`; // the bus fails while it is removed
const SELF = `rself${run}`; // publishes and subscribes to its own type, then stops publishing it
const typeOf = (id: string) => `${id}.thing.created.v1`;
const otherOf = (id: string) => `${id}.thing.deleted.v1`;
const ADMIN_TOKEN = "t".repeat(40);
const enc = new TextEncoder();

function manifest(id: string, publishes: string[], subscribes: string[] = []) {
  return {
    id,
    name: "Remove test",
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
    ...(publishes.length || subscribes.length
      ? {
          events: {
            ...(publishes.length
              ? { publishes: publishes.map((type) => ({ type, schema: "./events/thing.json" })) }
              : {}),
            ...(subscribes.length
              ? { subscribes: subscribes.map((type) => ({ type, handler: "/internal/events" })) }
              : {}),
          },
        }
      : {}),
    ui: { glyph: "RM", color: "#b91c1c", nav: [], status: "active" },
  };
}

interface Catalog {
  events: {
    type: string;
    publisher: { appId: string } | null;
    subscribers: { appId: string; consumer: string }[];
  }[];
}

describe.skipIf(!ADMIN_URL || !NATS_URL)("remove an app (#68, integration: Postgres + NATS)", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let bus: StreamAdmin;
  let nc: NatsConnection;
  let jsm: JetStreamManager;
  const servers: Server[] = [];
  const credentials: Record<string, string> = {};
  let base: string;

  async function coreApi(b: EventBus) {
    const registry = createRegistry({
      pool,
      bus: b,
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

  const cli = (path: string, body?: object, at = base) =>
    fetch(`${at}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  const get = async <T>(path: string) =>
    (await (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json()) as T;
  const install = async (id: string, publishes: string[], subscribes: string[] = [], at = base) => {
    const res = await cli(`/admin/v1/apps/${id}/install`, manifest(id, publishes, subscribes), at);
    expect(res.status).toBe(201);
    credentials[id] = ((await res.json()) as { credential: string }).credential;
  };
  const register = (id: string, publishes: string[], subscribes: string[] = []) => {
    const body = JSON.stringify(manifest(id, publishes, subscribes));
    return fetch(`${base}/registry/v1/apps/${id}`, {
      method: "POST",
      headers: signRegistration({ appId: id, credential: credentials[id]!, body }),
      body,
    });
  };
  const uploadSchemas = (id: string, types: string[]) => {
    const path = `/registry/v1/apps/${id}/event-schemas`;
    const body = JSON.stringify({ schemas: Object.fromEntries(types.map((t) => [t, { type: "object" }])) });
    return fetch(`${base}${path}`, {
      method: "PUT",
      headers: { ...signRequest({ credential: credentials[id]!, method: "PUT", path, body }) },
      body,
    });
  };
  const remove = (id: string, at = base) => cli(`/admin/v1/apps/${id}/remove`, undefined, at);
  const json = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as T;
  const streamExists = (id: string) =>
    jsm.streams.info(streamName(id)).then(
      () => true,
      () => false,
    );
  const consumerExists = (app: string, type: string, publisher: string) =>
    jsm.consumers.info(streamName(publisher), consumerName(app, type)).then(
      () => true,
      () => false,
    );
  const grant = (role: string, sub: string) =>
    fetch(`${base}/admin/v1/roles/${role}/grants/${sub}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
  const entry = async (type: string) => (await get<Catalog>("/admin/v1/events")).events.find((e) => e.type === type);

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${coreDb}"`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${coreDb}`;
    pool = new pg.Pool({ connectionString: url.href, max: 4 });
    await migrate(pool);
    bus = createStreamAdmin({ servers: NATS_URL!, ...NATS_AUTH });
    nc = await connect({ servers: NATS_URL!, ...NATS_AUTH });
    jsm = await jetstreamManager(nc);
    base = await coreApi(bus);
  });

  afterAll(async () => {
    for (const s of servers) s.close();
    if (jsm) for (const id of [PUB, PUB2, FAIL, SELF]) await jsm.streams.delete(streamName(id)).catch(() => undefined);
    await nc?.close();
    await bus?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${coreDb}"`);
      await admin.end();
    }
  });

  it("a publisher: its stream and messages, its subscribers' consumers and its catalog entries go; it can't register or upload", async () => {
    await install(PUB, [typeOf(PUB)]);
    expect((await register(PUB, [typeOf(PUB)])).status).toBe(200);
    expect((await uploadSchemas(PUB, [typeOf(PUB)])).status).toBe(200);
    await install(SUB, [], [typeOf(PUB)]);
    expect((await register(SUB, [], [typeOf(PUB)])).status).toBe(200);
    expect(await consumerExists(SUB, typeOf(PUB), PUB)).toBe(true);
    expect((await grant(`${PUB}.viewer`, "dev-member")).status).toBe(200);
    // An event from before the removal, waiting for SUB.
    await jetstream(nc).publish(typeOf(PUB), enc.encode("{}"));
    expect((await jsm.consumers.info(streamName(PUB), consumerName(SUB, typeOf(PUB)))).num_pending).toBe(1);

    const res = await remove(PUB);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      appId: PUB,
      state: "removed",
      previous: "installed",
      from: "installed",
      revokedCredentials: 1,
      removedGrants: [{ role: `${PUB}.viewer`, subject: "dev-member" }],
      removedEventSchemas: [typeOf(PUB)],
      consumers: "none",
      dependentConsumers: { [SUB]: { [typeOf(PUB)]: "deleted" } },
      stream: { stream: streamName(PUB), result: "deleted" },
      warnings: [{ app: SUB, type: typeOf(PUB), code: "waiting_for_publisher" }],
    });

    expect(await streamExists(PUB)).toBe(false);
    expect(await consumerExists(SUB, typeOf(PUB), PUB)).toBe(false);
    // The type has no publisher any more: a dangling subscription, waiting.
    expect(await entry(typeOf(PUB))).toMatchObject({
      publisher: null,
      subscribers: [{ appId: SUB, consumer: "waiting_for_publisher" }],
    });
    // Registry rows.
    expect(
      (await pool.query("SELECT 1 FROM app_credentials WHERE app_id = $1 AND revoked_at IS NULL", [PUB])).rowCount,
    ).toBe(0);
    expect((await pool.query("SELECT 1 FROM event_schemas WHERE app_id = $1", [PUB])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM roles WHERE app_id = $1 AND deprecated_at IS NULL", [PUB])).rowCount).toBe(
      0,
    );
    expect(
      (await pool.query("SELECT 1 FROM permissions WHERE app_id = $1 AND deprecated_at IS NULL", [PUB])).rowCount,
    ).toBe(0);
    // A removed app can't register or upload schemas (an unknown app), and its roles can't be granted.
    const reg = await register(PUB, [typeOf(PUB)]);
    expect([reg.status, (await json(reg)).error]).toEqual([403, "unknown_app"]);
    const up = await uploadSchemas(PUB, [typeOf(PUB)]);
    expect([up.status, (await json(up)).error]).toEqual([403, "unknown_app"]);
    expect((await grant(`${PUB}.viewer`, "dev-member")).status).toBe(404);
    const audit = await pool.query(
      "SELECT actor, detail FROM audit_events WHERE app_id = $1 AND action = 'app.removed'",
      [PUB],
    );
    expect(audit.rows).toEqual([
      expect.objectContaining({ actor: "admin", detail: expect.objectContaining({ revokedCredentials: 1 }) }),
    ]);
  });

  it("reinstall + register: a fresh stream, SUB's consumer bound again, roles back, no grants, nothing from before delivered", async () => {
    await install(PUB, [typeOf(PUB)]);
    expect(await streamExists(PUB)).toBe(true);
    expect((await jsm.streams.info(streamName(PUB))).state.messages).toBe(0);
    expect(await consumerExists(SUB, typeOf(PUB), PUB)).toBe(true);
    expect((await jsm.consumers.info(streamName(PUB), consumerName(SUB, typeOf(PUB)))).num_pending).toBe(0);
    // Like a first install: it waits for the app to register.
    expect((await get<{ registered_at: string | null }>(`/admin/v1/apps/${PUB}`)).registered_at).toBeNull();

    expect((await register(PUB, [typeOf(PUB)])).status).toBe(200);
    const app = await get<{ registered_at: string | null; roles: { key: string; deprecated_at: string | null }[] }>(
      `/admin/v1/apps/${PUB}`,
    );
    expect(app.registered_at).not.toBeNull();
    expect(app.roles).toEqual([{ key: `${PUB}.viewer`, deprecated_at: null }]);
    expect((await get<{ grants: unknown[] }>(`/admin/v1/roles/${PUB}.viewer/grants`)).grants).toEqual([]);
    expect(await entry(typeOf(PUB))).toMatchObject({
      publisher: { appId: PUB },
      subscribers: [{ appId: SUB, consumer: "bound" }],
    });

    // Only what is published after the reinstall reaches SUB.
    await jetstream(nc).publish(typeOf(PUB), enc.encode("{}"));
    expect((await jsm.consumers.info(streamName(PUB), consumerName(SUB, typeOf(PUB)))).num_pending).toBe(1);
  });

  it("a subscriber: its consumers go; the publisher's stream and messages stay", async () => {
    await install(PUB2, [typeOf(PUB2)]);
    await install(SUB2, [], [typeOf(PUB2)]);
    await jetstream(nc).publish(typeOf(PUB2), enc.encode("{}"));
    expect(await consumerExists(SUB2, typeOf(PUB2), PUB2)).toBe(true);

    const res = await remove(SUB2);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      consumers: { [typeOf(PUB2)]: "deleted" },
      dependentConsumers: "none",
      stream: { stream: streamName(SUB2), result: "absent" },
      warnings: [],
    });
    expect(await consumerExists(SUB2, typeOf(PUB2), PUB2)).toBe(false);
    expect((await jsm.streams.info(streamName(PUB2))).state.messages).toBe(1);
    expect((await entry(typeOf(PUB2)))?.subscribers).toEqual([]);
  });

  it("an active app is refused: deactivate it first", async () => {
    expect((await cli(`/admin/v1/apps/${PUB2}/activate`)).status).toBe(200);
    const res = await remove(PUB2);
    expect([res.status, (await json(res)).error]).toEqual([409, "invalid_state"]);
    expect(await streamExists(PUB2)).toBe(true);
    expect((await cli(`/admin/v1/apps/${PUB2}/deactivate`)).status).toBe(200);
    expect((await remove(PUB2)).status).toBe(200);
    expect(await streamExists(PUB2)).toBe(false);
  });

  it("a bus failure: 503 bus_unavailable and the state, credentials, grants and stream are as they were", async () => {
    await install(FAIL, [typeOf(FAIL)]);
    expect((await register(FAIL, [typeOf(FAIL)])).status).toBe(200); // its roles exist from registration
    expect((await grant(`${FAIL}.viewer`, "dev-member")).status).toBe(200);
    const down = await coreApi({
      ensureAppStream: bus.ensureAppStream,
      ensureConsumer: bus.ensureConsumer,
      deleteConsumer: bus.deleteConsumer,
      deleteAppStream: async () => {
        throw new Error("connection refused");
      },
    });
    const res = await remove(FAIL, down);
    expect([res.status, (await json(res)).error]).toEqual([503, "bus_unavailable"]);
    expect((await pool.query("SELECT state FROM apps WHERE id = $1", [FAIL])).rows[0].state).toBe("installed");
    expect(
      (await pool.query("SELECT 1 FROM app_credentials WHERE app_id = $1 AND revoked_at IS NULL", [FAIL])).rowCount,
    ).toBe(1);
    expect((await get<{ grants: unknown[] }>(`/admin/v1/roles/${FAIL}.viewer/grants`)).grants).toHaveLength(1);
    expect(await streamExists(FAIL)).toBe(true);
    expect(
      (await pool.query("SELECT 1 FROM audit_events WHERE app_id = $1 AND action = 'app.removed'", [FAIL])).rowCount,
    ).toBe(0);
    // The admin retries once the bus is back.
    expect((await remove(FAIL)).status).toBe(200);
    expect(await streamExists(FAIL)).toBe(false);
  });

  it("a self-subscribing publisher that stops publishing its type loses its own consumer, and repeated registrations don't flip it", async () => {
    await install(SELF, [typeOf(SELF), otherOf(SELF)], [typeOf(SELF)]);
    expect(await consumerExists(SELF, typeOf(SELF), SELF)).toBe(true);

    for (let i = 0; i < 3; i++) {
      const res = await register(SELF, [otherOf(SELF)], [typeOf(SELF)]);
      expect(res.status).toBe(200);
      const { events } = await json<{ events: { consumers: unknown; removedConsumers: unknown; warnings: unknown } }>(
        res,
      );
      expect(events.consumers).toBe("none");
      expect(events.removedConsumers).toEqual({ [typeOf(SELF)]: i === 0 ? "deleted" : "absent" });
      expect(events.warnings).toEqual([{ type: typeOf(SELF), code: "waiting_for_publisher" }]);
      expect(await consumerExists(SELF, typeOf(SELF), SELF)).toBe(false);
    }
    expect(await entry(typeOf(SELF))).toMatchObject({
      publisher: null,
      subscribers: [{ appId: SELF, consumer: "waiting_for_publisher" }],
    });
    // Publishing it again brings the consumer back.
    expect((await register(SELF, [typeOf(SELF), otherOf(SELF)], [typeOf(SELF)])).status).toBe(200);
    expect(await consumerExists(SELF, typeOf(SELF), SELF)).toBe(true);
  });
});
