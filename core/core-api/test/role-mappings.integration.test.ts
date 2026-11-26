/**
 * Administrator-configured role mappings (#355, ADR 0004) against a real Postgres: derived grants follow the
 * source role, deliberate grants are never removed, a derived grant can't be revoked directly, nothing maps into
 * core, and the admin API answers. Needs CORE_API_TEST_ADMIN_URL (see registry.integration.test.ts).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.ts";
import { createRegistry, type Registry } from "../src/registry.ts";
import { createHandler } from "../src/server.ts";

const ADMIN_URL = process.env.CORE_API_TEST_ADMIN_URL;
if (process.env.CORE_API_TEST_REQUIRED && !ADMIN_URL) throw new Error("CORE_API_TEST_ADMIN_URL must be set");

const coreDb = `core_mappings_${Date.now().toString(36)}`;
const ADMIN_TOKEN = "m".repeat(40);
const ADMIN = "admin:test";

describe.skipIf(!ADMIN_URL)("role mappings (integration)", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let registry: Registry;
  let server: Server;
  let base: string;

  /** Who holds `role`, and how: the subject → granted_by. */
  const holders = async (role: string) =>
    Object.fromEntries(
      (
        await pool.query<{ subject: string; granted_by: string }>(
          "SELECT subject, granted_by FROM role_grants WHERE role_key = $1 ORDER BY subject",
          [role],
        )
      ).rows.map((r) => [r.subject, r.granted_by]),
    );

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${coreDb}"`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${coreDb}`;
    pool = new pg.Pool({ connectionString: url.href, max: 4 });
    await migrate(pool);
    // Two apps' catalogs, as registration would leave them (registration itself is tested elsewhere).
    for (const id of ["knowledge", "wiki"]) {
      await pool.query(
        "INSERT INTO apps (id, version, manifest, state, database_name) VALUES ($1, '0.1.0', '{}', 'inactive', NULL)",
        [id],
      );
    }
    await pool.query(
      `INSERT INTO roles (key, app_id) VALUES ('knowledge.author', 'knowledge'), ('knowledge.editor', 'knowledge'),
         ('wiki.writer', 'wiki'), ('wiki.reader', 'wiki')`,
    );
    registry = createRegistry({
      pool,
      provisioner: async () => {
        throw new Error("not used");
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
    await admin?.query(`DROP DATABASE IF EXISTS "${coreDb}" WITH (FORCE)`);
    await admin?.end();
  });

  it("gives every current and future holder of the source the target, and takes it back with the source", async () => {
    await registry.grantRole("core.admin", "ann", ADMIN);
    const m = await registry.createRoleMapping("core.admin", "knowledge.author", ADMIN);
    expect(m.derivedGrants).toBe(1);
    expect(await holders("knowledge.author")).toEqual({ ann: `mapping:${m.id}` });

    // A future holder gets it with the grant, in the same transaction.
    await registry.grantRole("core.admin", "ben", ADMIN);
    expect(await holders("knowledge.author")).toEqual({ ann: `mapping:${m.id}`, ben: `mapping:${m.id}` });

    // Losing the source takes the derived grant away.
    await registry.revokeRole("core.admin", "ben", ADMIN);
    expect(await holders("knowledge.author")).toEqual({ ann: `mapping:${m.id}` });

    const audit = (
      await pool.query<{ actor: string; action: string; detail: { subject?: string; via?: string } }>(
        "SELECT actor, action, detail FROM audit_events WHERE action LIKE 'role.%' ORDER BY id",
      )
    ).rows.map((r) => [r.action, r.actor, r.detail.subject ?? null]);
    expect(audit).toContainEqual(["role.mapped", ADMIN, null]);
    expect(audit).toContainEqual(["role.granted", `mapping:${m.id}`, "ben"]);
    expect(audit).toContainEqual(["role.revoked", `mapping:${m.id}`, "ben"]);
    await registry.deleteRoleMapping(m.id, ADMIN);
  });

  it("keeps a deliberate grant when the source goes or the mapping is deleted", async () => {
    await registry.grantRole("wiki.writer", "cat", ADMIN);
    await registry.grantRole("wiki.writer", "dan", ADMIN);
    await registry.grantRole("knowledge.editor", "dan", ADMIN); // deliberate, before any mapping
    const m = await registry.createRoleMapping("wiki.writer", "knowledge.editor", ADMIN);
    expect(await holders("knowledge.editor")).toEqual({ cat: `mapping:${m.id}`, dan: ADMIN });

    await registry.revokeRole("wiki.writer", "dan", ADMIN);
    expect(await holders("knowledge.editor")).toEqual({ cat: `mapping:${m.id}`, dan: ADMIN });

    // Granting a role someone holds through a mapping makes it deliberate: it then outlives the mapping.
    expect((await registry.grantRole("knowledge.editor", "cat", ADMIN)).granted).toBe(true);
    const out = await registry.deleteRoleMapping(m.id, ADMIN);
    expect(out.removedGrants).toBe(0);
    expect(await holders("knowledge.editor")).toEqual({ cat: ADMIN, dan: ADMIN });
    await registry.revokeRole("wiki.writer", "cat", ADMIN);
  });

  it("deleting a mapping removes only its derived grants, and another mapping keeps the role", async () => {
    await registry.grantRole("wiki.reader", "eve", ADMIN);
    await registry.grantRole("wiki.writer", "eve", ADMIN);
    await registry.grantRole("wiki.writer", "fay", ADMIN);
    const a = await registry.createRoleMapping("wiki.reader", "knowledge.author", ADMIN);
    const b = await registry.createRoleMapping("wiki.writer", "knowledge.author", ADMIN);
    expect(await holders("knowledge.author")).toEqual({ eve: `mapping:${a.id}`, fay: `mapping:${b.id}` });

    // Eve still qualifies through b: the grant stays and moves to b.
    expect((await registry.deleteRoleMapping(a.id, ADMIN)).removedGrants).toBe(0);
    expect(await holders("knowledge.author")).toEqual({ eve: `mapping:${b.id}`, fay: `mapping:${b.id}` });
    expect((await registry.deleteRoleMapping(b.id, ADMIN)).removedGrants).toBe(2);
    expect(await holders("knowledge.author")).toEqual({});
  });

  it("refuses to revoke a derived grant directly, and isn't transitive", async () => {
    await registry.grantRole("wiki.reader", "gus", ADMIN);
    const a = await registry.createRoleMapping("wiki.reader", "wiki.writer", ADMIN);
    const b = await registry.createRoleMapping("wiki.writer", "knowledge.editor", ADMIN);
    // gus holds wiki.writer only through a, so b (from wiki.writer) gives him nothing.
    expect((await holders("wiki.writer")).gus).toBe(`mapping:${a.id}`);
    expect((await holders("knowledge.editor")).gus).toBeUndefined();
    await expect(registry.revokeRole("wiki.writer", "gus", ADMIN)).rejects.toMatchObject({ code: "invalid_state" });
    expect((await holders("wiki.writer")).gus).toBe(`mapping:${a.id}`);
    // Revoking a deliberate grant the mapping still entitles leaves the derived one.
    await registry.grantRole("wiki.writer", "gus", ADMIN);
    await registry.revokeRole("wiki.writer", "gus", ADMIN);
    expect((await holders("wiki.writer")).gus).toBe(`mapping:${a.id}`);
    await registry.deleteRoleMapping(b.id, ADMIN);
    await registry.deleteRoleMapping(a.id, ADMIN);
    await registry.revokeRole("wiki.reader", "gus", ADMIN);
  });

  it("never maps into core, never a role to itself, only existing roles, and each pair once", async () => {
    await expect(registry.createRoleMapping("knowledge.author", "core.admin", ADMIN)).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(registry.createRoleMapping("wiki.reader", "wiki.reader", ADMIN)).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(registry.createRoleMapping("wiki.ghost", "wiki.reader", ADMIN)).rejects.toMatchObject({
      code: "role_not_found",
    });
    const m = await registry.createRoleMapping("wiki.reader", "knowledge.editor", ADMIN);
    await expect(registry.createRoleMapping("wiki.reader", "knowledge.editor", ADMIN)).rejects.toMatchObject({
      code: "invalid_state",
    });
    // The database refuses it too.
    await expect(
      pool.query(
        "INSERT INTO role_mappings (source_role, target_role, created_by) VALUES ('wiki.reader', 'core.admin', 'x')",
      ),
    ).rejects.toThrow();
    await registry.deleteRoleMapping(m.id, ADMIN);
    await expect(registry.deleteRoleMapping(m.id, ADMIN)).rejects.toMatchObject({ code: "not_found" });
  });

  it("serves the mappings over the admin API", async () => {
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    await registry.grantRole("core.admin", "ann", ADMIN); // already hers from the first test: a no-op then
    await registry.grantRole("core.admin", "hal", ADMIN);
    const created = await call("POST", "/admin/v1/role-mappings", { source: "core.admin", target: "knowledge.author" });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };
    const list = (await (await call("GET", "/admin/v1/role-mappings")).json()) as {
      mappings: { id: number; source: string; target: string; derivedGrants: number }[];
    };
    expect(list.mappings.find((x) => x.id === id)).toMatchObject({
      source: "core.admin",
      target: "knowledge.author",
      derivedGrants: 2, // ann and hal
    });
    expect((await call("POST", "/admin/v1/role-mappings", { source: "core.admin", target: "core.admin" })).status).toBe(
      400,
    );
    expect((await call("POST", "/admin/v1/role-mappings", { source: "*", target: "knowledge.author" })).status).toBe(
      400,
    );
    const revokeDerived = await call("DELETE", "/admin/v1/roles/knowledge.author/grants/hal");
    expect(revokeDerived.status).toBe(409);
    expect((await call("DELETE", `/admin/v1/role-mappings/${id}`)).status).toBe(200);
    expect(await holders("knowledge.author")).toEqual({});
  });
});
