/**
 * The event catalog (P4.2) over HTTP against a real Postgres: install → register → the signed
 * schema upload → `GET /admin/v1/events`; an upgrade that stops publishing a type drops its schema
 * and its catalog entry; every upload refusal (signature, replay, removed app, type set, ajv, size).
 *
 * Needs CORE_API_TEST_ADMIN_URL (see registry.integration.test.ts); no bus. Skipped without it,
 * except when CORE_API_TEST_REQUIRED is set (CI).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signRegistration, signRequest } from "../src/credentials.ts";
import { migrate } from "../src/migrate.ts";
import { appDatabaseNames } from "../src/provision.ts";
import { createRegistry } from "../src/registry.ts";
import { createHandler } from "../src/server.ts";

const ADMIN_URL = process.env.CORE_API_TEST_ADMIN_URL;
if (process.env.CORE_API_TEST_REQUIRED && !ADMIN_URL) throw new Error("CORE_API_TEST_ADMIN_URL must be set");

const run = Date.now().toString(36);
const coreDb = `core_catalog_${run}`;
const PUB = `pub-${run}`;
const SUB = `sub-${run}`;
const ADMIN_TOKEN = "c".repeat(40);
const CREATED = `${PUB}.thing.created.v1`;
const DELETED = `${PUB}.thing.deleted.v1`;
const GHOST = `ghost-${run}.thing.created.v1`;

function manifest(id: string, version: string, events: object) {
  return {
    id,
    name: id,
    version,
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
    events,
    ui: { glyph: "EV", color: "#7c3aed", nav: [], status: "active" },
  };
}

const pubV1 = manifest(PUB, "0.1.0", {
  publishes: [
    { type: CREATED, schema: "./events/created.json" },
    { type: DELETED, schema: "./events/deleted.json" },
  ],
});
const pubV2 = manifest(PUB, "0.2.0", { publishes: [{ type: CREATED, schema: "./events/created.json" }] });
const subV1 = manifest(SUB, "0.1.0", {
  subscribes: [
    { type: CREATED, handler: "/events/created" },
    { type: GHOST, handler: "/events/ghost" },
  ],
});

const schema = (title: string) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title,
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" }, at: { type: "string", format: "date-time" } },
});

interface Entry {
  type: string;
  publisher: { appId: string; version: string; state: string } | null;
  schema: { title?: string } | null;
  schemaStatus: string;
  schemaUpdatedAt: string | null;
  schemaAppVersion: string | null;
  subscribers: { appId: string; handler: string; consumer: string; state: string }[];
}

describe.skipIf(!ADMIN_URL)("core-api event catalog (integration)", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let server: Server;
  let base: string;
  const credentials = new Map<string, string>();

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${coreDb}"`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${coreDb}`;
    pool = new pg.Pool({ connectionString: url.href, max: 4 });
    await migrate(pool);
    const registry = createRegistry({
      pool,
      provisioner: async () => {
        const c = new pg.Client({ connectionString: ADMIN_URL });
        await c.connect();
        return c;
      },
      appDatabaseHost: { host: url.hostname, port: Number(url.port) },
    });
    server = createServer(createHandler({ registry, pool, adminToken: ADMIN_TOKEN, log: () => {} }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${coreDb}"`);
      for (const id of [PUB, SUB]) {
        const { database, role } = appDatabaseNames(id);
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      }
      await admin.end();
    }
  });

  async function install(m: { id: string }) {
    const res = await fetch(`${base}/admin/v1/apps/${m.id}/install`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(m),
    });
    expect(res.status).toBe(201);
    credentials.set(m.id, ((await res.json()) as { credential: string }).credential);
  }

  async function register(m: { id: string }) {
    const body = JSON.stringify(m);
    const headers = signRegistration({ appId: m.id, credential: credentials.get(m.id)!, body });
    const res = await fetch(`${base}/registry/v1/apps/${m.id}`, { method: "POST", headers, body });
    expect(res.status).toBe(200);
  }

  async function upload(
    id: string,
    payload: unknown,
    opts: { credential?: string; headers?: Record<string, string>; body?: string } = {},
  ) {
    const path = `/registry/v1/apps/${id}/event-schemas`;
    const body = opts.body ?? JSON.stringify(payload);
    const headers =
      opts.headers ?? signRequest({ credential: opts.credential ?? credentials.get(id)!, method: "PUT", path, body });
    const res = await fetch(`${base}${path}`, { method: "PUT", headers, body });
    return {
      status: res.status,
      body: (await res.json()) as { error?: string; message?: string; types?: string[]; version?: string },
    };
  }

  async function catalog(token = ADMIN_TOKEN) {
    const res = await fetch(`${base}/admin/v1/events`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json()) as { events: Entry[]; error?: string } };
  }

  const entry = async (type: string) => (await catalog()).body.events.find((e) => e.type === type);

  it("before any upload: each published type is listed with schemaStatus not_provided, subscribers and dangling ones", async () => {
    await install(pubV1);
    await install(subV1);
    await register(pubV1);
    await register(subV1);

    const { status, body } = await catalog();
    expect(status).toBe(200);
    const mine = body.events.filter((e) => [CREATED, DELETED, GHOST].includes(e.type));
    expect(mine.map((e) => e.type)).toEqual([GHOST, CREATED, DELETED].sort());
    expect(mine.find((e) => e.type === CREATED)).toEqual({
      type: CREATED,
      publisher: { appId: PUB, version: "0.1.0", state: "installed" },
      schema: null,
      schemaStatus: "not_provided",
      schemaUpdatedAt: null,
      schemaAppVersion: null,
      subscribers: [{ appId: SUB, state: "installed", handler: "/events/created", consumer: "bound" }],
    });
    expect(mine.find((e) => e.type === DELETED)).toMatchObject({ schemaStatus: "not_provided", subscribers: [] });
    // A subscription nobody publishes: listed, with no publisher.
    expect(mine.find((e) => e.type === GHOST)).toEqual({
      type: GHOST,
      publisher: null,
      schema: null,
      schemaStatus: "no_publisher",
      schemaUpdatedAt: null,
      schemaAppVersion: null,
      subscribers: [{ appId: SUB, state: "installed", handler: "/events/ghost", consumer: "waiting_for_publisher" }],
    });
  });

  it("GET /admin/v1/events needs the admin API's auth (core.admin or the CLI token)", async () => {
    expect((await catalog("wrong".repeat(10))).status).toBe(401);
    const res = await fetch(`${base}/admin/v1/events`);
    expect(res.status).toBe(401);
  });

  it("the app uploads its schemas (signed): stored, audited without the bodies, in the catalog", async () => {
    const res = await upload(PUB, { schemas: { [CREATED]: schema("created"), [DELETED]: schema("deleted") } });
    expect(res).toEqual({ status: 200, body: { appId: PUB, version: "0.1.0", types: [CREATED, DELETED] } });

    const created = await entry(CREATED);
    expect(created).toMatchObject({
      schemaStatus: "provided",
      schemaAppVersion: "0.1.0",
      schema: { title: "created" },
    });
    expect(Date.parse(created!.schemaUpdatedAt!)).not.toBeNaN();
    expect((await entry(DELETED))?.schema).toMatchObject({ title: "deleted" });

    const audit = await pool.query("SELECT actor, detail FROM audit_events WHERE action = 'event_schemas.updated'");
    expect(audit.rows).toEqual([{ actor: `app:${PUB}`, detail: { version: "0.1.0", types: [CREATED, DELETED] } }]);
    expect(JSON.stringify(audit.rows)).not.toContain("properties");
  });

  it("a second upload replaces the whole set", async () => {
    const res = await upload(PUB, { schemas: { [CREATED]: schema("created 2"), [DELETED]: schema("deleted 2") } });
    expect(res.status).toBe(200);
    expect((await entry(CREATED))?.schema).toMatchObject({ title: "created 2" });
    expect(Number((await pool.query("SELECT count(*) AS n FROM event_schemas")).rows[0].n)).toBe(2);
  });

  it("a missing, extra or non-compiling schema is refused (400 invalid_event_schemas, naming the type); nothing changes", async () => {
    const missing = await upload(PUB, { schemas: { [CREATED]: schema("x") } });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("invalid_event_schemas");
    expect(missing.body.message).toContain(DELETED);

    const extra = await upload(PUB, {
      schemas: { [CREATED]: schema("x"), [DELETED]: schema("x"), [`${PUB}.thing.moved.v1`]: schema("x") },
    });
    expect(extra.status).toBe(400);
    expect(extra.body.message).toContain(`${PUB}.thing.moved.v1`);

    const broken = await upload(PUB, { schemas: { [CREATED]: { type: "nope" }, [DELETED]: schema("x") } });
    expect(broken.status).toBe(400);
    expect(broken.body.error).toBe("invalid_event_schemas");
    expect(broken.body.message).toContain(CREATED);

    // An app can't upload for a type it subscribes to (another app's).
    const theirs = await upload(SUB, { schemas: { [CREATED]: schema("x") } });
    expect(theirs.status).toBe(400);
    expect(theirs.body.message).toContain(CREATED);

    const notJson = await upload(PUB, undefined, { body: "{nope" });
    expect(notJson).toMatchObject({ status: 400, body: { error: "bad_request" } });

    expect((await entry(CREATED))?.schema).toMatchObject({ title: "created 2" });
  });

  it("an oversized schema (> 64 KiB) or request (> 512 KiB) gets 413", async () => {
    const big = { ...schema("big"), description: "x".repeat(65 * 1024) };
    const one = await upload(PUB, { schemas: { [CREATED]: big, [DELETED]: schema("x") } });
    expect(one.status).toBe(413);
    expect(one.body.error).toBe("payload_too_large");
    expect(one.body.message).toContain(CREATED);

    const huge = await upload(PUB, { schemas: { [CREATED]: schema("x"), pad: "x".repeat(513 * 1024) } });
    expect(huge.status).toBe(413);
    expect(huge.body.error).toBe("payload_too_large");
  });

  it("refused: no signature, another app's key, a replayed nonce, a GET-signed request", async () => {
    const payload = { schemas: { [CREATED]: schema("x"), [DELETED]: schema("x") } };
    const body = JSON.stringify(payload);
    const path = `/registry/v1/apps/${PUB}/event-schemas`;

    expect(await upload(PUB, payload, { headers: {} })).toMatchObject({
      status: 401,
      body: { error: "missing_signature" },
    });
    // SUB's credential signing for PUB's path: its key id isn't PUB's.
    expect(await upload(PUB, payload, { credential: credentials.get(SUB)! })).toMatchObject({
      status: 401,
      body: { error: "bad_signature" },
    });
    // A registration-style POST signature isn't a PUT signature.
    const post = signRequest({ credential: credentials.get(PUB)!, method: "POST", path, body });
    expect(await upload(PUB, payload, { headers: post })).toMatchObject({
      status: 401,
      body: { error: "bad_signature" },
    });
    const headers = signRequest({ credential: credentials.get(PUB)!, method: "PUT", path, body });
    expect((await upload(PUB, payload, { headers })).status).toBe(200);
    expect(await upload(PUB, payload, { headers })).toMatchObject({
      status: 401,
      body: { error: "replayed_signature" },
    });
  });

  it("an upgrade that stops publishing a type drops its schema row and its catalog entry, in the same transaction", async () => {
    await register(pubV2);
    const rows = await pool.query("SELECT event_type, app_version FROM event_schemas WHERE app_id = $1", [PUB]);
    expect(rows.rows).toEqual([{ event_type: CREATED, app_version: "0.1.0" }]);
    expect(await entry(DELETED)).toBeUndefined();
    // The kept type keeps its schema (uploaded by 0.1.0) until the app uploads again.
    expect(await entry(CREATED)).toMatchObject({
      publisher: { appId: PUB, version: "0.2.0" },
      schemaStatus: "provided",
      schemaAppVersion: "0.1.0",
    });
    const audit = await pool.query(
      "SELECT detail FROM audit_events WHERE action = 'app.registered' AND app_id = $1 ORDER BY id DESC LIMIT 1",
      [PUB],
    );
    expect(audit.rows[0].detail.removedEventSchemas).toEqual([DELETED]);

    // The old set no longer matches the manifest; the new one does.
    expect((await upload(PUB, { schemas: { [CREATED]: schema("x"), [DELETED]: schema("x") } })).status).toBe(400);
    expect(await upload(PUB, { schemas: { [CREATED]: schema("v2") } })).toMatchObject({
      status: 200,
      body: { version: "0.2.0", types: [CREATED] },
    });
    expect(await entry(CREATED)).toMatchObject({ schemaAppVersion: "0.2.0", schema: { title: "v2" } });
  });

  it("a removed app can't upload, and its types leave the catalog (its subscribers' become dangling)", async () => {
    await pool.query("UPDATE apps SET state = 'removed' WHERE id = $1", [PUB]);
    expect(await upload(PUB, { schemas: { [CREATED]: schema("x") } })).toMatchObject({
      status: 403,
      body: { error: "unknown_app" },
    });
    expect(await entry(CREATED)).toMatchObject({
      publisher: null,
      schemaStatus: "no_publisher",
      subscribers: [{ appId: SUB, consumer: "waiting_for_publisher" }],
    });
  });
});
