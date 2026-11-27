/**
 * Account actions for the Admin console's Users page (PgIdentityStore.adminSuspend and adminReactivate) on a real
 * Postgres (IDENTITY_TEST_DATABASE_URL, a login that may CREATE DATABASE), in a throwaway database: what each does,
 * that a retry changes nothing, that every change and refusal is audited with actor and target, and that nobody can
 * lock identity's administration out (not yourself, never the last identity admin, also under concurrency).
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgIdentityStore } from "../src/store.ts";
import { pid } from "./fakes.ts";

const DATABASE_URL = process.env.IDENTITY_TEST_DATABASE_URL;
if (process.env.CI && !DATABASE_URL) throw new Error("IDENTITY_TEST_DATABASE_URL must be set in CI");

describe.skipIf(!DATABASE_URL)("account actions (Postgres)", () => {
  const dbName = `identity_actions_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let db: pg.Pool;
  let store: PgIdentityStore;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(DATABASE_URL!);
    u.pathname = `/${dbName}`;
    store = new PgIdentityStore(u.href);
    db = new pg.Pool({ connectionString: u.href, max: 2 });
    // afterAll drops the database WITH (FORCE): a connection still closing then reports 57P01 on the pool.
    db.on("error", () => undefined);
    await store.migrate();
    // ali and bea: identity admins with access. mo: a member with a global connection. pat: public sign-up at
    // knowledge only. sam: asked for access, has none.
    await store.bootstrapAdmin([{ method: "email", identifier: "ali@example.test" }]);
    ids.ali = await pid(store.verifiedLogin("email", "ali@example.test"));
    ids.bea = await store.addConnection("email", "bea@example.test", ids.ali);
    await db.query("UPDATE principals SET is_admin = true WHERE id = $1", [ids.bea]);
    ids.mo = await store.addConnection("email", "mo@example.test", ids.ali);
    ids.pat = await pid(store.verifiedLogin("email", "pat@example.test"));
    expect(await store.admitPublic(ids.pat, "knowledge")).toBe("admitted");
    ids.sam = await pid(store.verifiedLogin("email", "sam@example.test"));
  });

  afterAll(async () => {
    await store?.close();
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  const state = async (id: string) => {
    const p = (await store.directoryProfile(id))!;
    return { state: p.state, scope: p.scope };
  };
  const audit = async (principal: string) =>
    (
      await db.query<{ event: string; actor_id: string | null; detail: Record<string, unknown> }>(
        "SELECT event, actor_id, detail FROM audit_log WHERE principal_id = $1 ORDER BY id",
        [principal],
      )
    ).rows.map((r) => ({ event: r.event, actor: r.actor_id, detail: r.detail }));

  it("suspends a member and reconnects them; a retry of either changes nothing; each change is audited", async () => {
    expect(await store.adminSuspend(ids.mo!, ids.ali!)).toBe("suspended");
    expect(await state(ids.mo!)).toEqual({ state: "suspended", scope: "none" });
    expect(await store.adminSuspend(ids.mo!, ids.ali!)).toBe("already");
    expect(await store.adminReactivate(ids.mo!, ids.bea!)).toBe("reconnected");
    expect(await state(ids.mo!)).toEqual({ state: "active", scope: "global" });
    expect(await store.adminReactivate(ids.mo!, ids.bea!)).toBe("not_suspended");
    const trail = (await audit(ids.mo!)).filter((e) => e.detail.via === "admin_api");
    expect(trail).toEqual([
      { event: "connection.revoked", actor: ids.ali, detail: { via: "admin_api" } },
      { event: "connection.added", actor: ids.bea, detail: { reconnect: true, via: "admin_api" } },
    ]);
  });

  it("a public-only person's suspension lifts back to their admissions, never to every app", async () => {
    expect(await store.adminSuspend(ids.pat!, ids.ali!)).toBe("suspended");
    expect(await state(ids.pat!)).toEqual({ state: "suspended", scope: "none" });
    expect(await store.adminReactivate(ids.pat!, ids.ali!)).toBe("admissions_restored");
    expect(await state(ids.pat!)).toEqual({ state: "active", scope: "apps" });
  });

  it("nothing to suspend for someone without access; an unknown account is unknown", async () => {
    expect(await store.adminSuspend(ids.sam!, ids.ali!)).toBe("no_access");
    expect(await store.adminSuspend("0190b6c4-0000-7000-8000-00000000ffff", ids.ali!)).toBe("unknown");
    expect(await store.adminSuspend("not-an-id", ids.ali!)).toBe("unknown");
    expect(await store.adminReactivate("0190b6c4-0000-7000-8000-00000000ffff", ids.ali!)).toBe("unknown");
  });

  it("never yourself, never the last identity admin; refusals are audited with their reason", async () => {
    expect(await store.adminSuspend(ids.ali!, ids.ali!)).toBe("self");
    expect(await store.adminSuspend(ids.bea!, ids.ali!)).toBe("suspended");
    // bea is out, so ali is the last identity admin with access: nobody (here bea's stale session) may suspend ali.
    expect(await store.adminSuspend(ids.ali!, ids.bea!)).toBe("last_admin");
    expect(await state(ids.ali!)).toEqual({ state: "active", scope: "global" });
    const denials = (await audit(ids.ali!)).filter((e) => e.event === "admin.denied");
    expect(denials).toEqual([
      { event: "admin.denied", actor: ids.ali, detail: { via: "admin_api", action: "suspend", reason: "self" } },
      { event: "admin.denied", actor: ids.bea, detail: { via: "admin_api", action: "suspend", reason: "last_admin" } },
    ]);
    expect(await store.adminReactivate(ids.bea!, ids.ali!)).toBe("reconnected");
  });

  it("two admins suspending each other at the same moment: exactly one succeeds, one admin keeps access", async () => {
    for (let round = 0; round < 5; round++) {
      const results = await Promise.all([
        store.adminSuspend(ids.ali!, ids.bea!),
        store.adminSuspend(ids.bea!, ids.ali!),
      ]);
      expect(results.sort(), `round ${round}`).toEqual(["last_admin", "suspended"]);
      const active = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM principals p JOIN connections c ON c.principal_id = p.id
          WHERE p.is_admin AND c.status = 'active'`,
      );
      expect(active.rows[0]!.n).toBe(1);
      // Put the one who lost access back for the next round.
      const out = (await state(ids.ali!)).state === "suspended" ? ids.ali! : ids.bea!;
      const by = out === ids.ali ? ids.bea! : ids.ali!;
      expect(await store.adminReactivate(out, by)).toBe("reconnected");
    }
  });
});
