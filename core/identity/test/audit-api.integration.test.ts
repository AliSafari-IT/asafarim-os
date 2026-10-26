/**
 * The queries behind the Admin console's sign-in trail (PgIdentityStore.searchAudit and auditCounts) on a
 * real Postgres (IDENTITY_TEST_DATABASE_URL, a login that may CREATE DATABASE), in a throwaway database.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgIdentityStore } from "../src/store.ts";

const DATABASE_URL = process.env.IDENTITY_TEST_DATABASE_URL;
if (process.env.CI && !DATABASE_URL) throw new Error("IDENTITY_TEST_DATABASE_URL must be set in CI");

describe.skipIf(!DATABASE_URL)("the sign-in trail's queries (Postgres)", () => {
  const dbName = `identity_audit_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let store: PgIdentityStore;
  let ali: string;
  let sam: string;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(DATABASE_URL!);
    u.pathname = `/${dbName}`;
    store = new PgIdentityStore(u.href);
    await store.migrate();
    await store.bootstrapAdmin([{ method: "email", identifier: "ali@example.test" }]);
    ali = await store.verifiedLogin("email", "ali@example.test");
    sam = await store.verifiedLogin("email", "sam@example.test");
    await store.requestConnection(sam);
    await store.audit({
      event: "otp.verify_failed",
      method: "email",
      subjectHandle: "subj-handle-1",
      ipHandle: "ip-handle-1",
    });
    await store.audit({ event: "otp.verified", method: "email", principalId: sam, ipHandle: "ip-handle-1" });
    await store.audit({ event: "login.not_authorized", method: "email", principalId: sam, ipHandle: "ip-handle-1" });
    await store.audit({ event: "login.granted", method: "passkey", principalId: ali, ipHandle: "ip-handle-2" });
    const [req] = await store.pendingRequests();
    await store.decideRequest(req!.id, "approved", ali);
  });

  afterAll(async () => {
    await store?.close();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it("newest first, with the person's and the actor's labels", async () => {
    const { events, next } = await store.searchAudit({});
    expect(next).toBeNull();
    expect(events.map((e) => e.event).slice(0, 3)).toEqual([
      "request.approved",
      "login.granted",
      "login.not_authorized",
    ]);
    expect(events[0]).toMatchObject({
      principalId: sam,
      label: "sam@example.test",
      actorId: ali,
      actorLabel: "ali@example.test",
    });
    const ids = events.map((e) => e.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
  });

  it("filters: exact event, a kind, method, a person (subject or actor), a handle, time and paging", async () => {
    const names = async (f: Parameters<PgIdentityStore["searchAudit"]>[0]) =>
      (await store.searchAudit(f)).events.map((e) => e.event);
    expect(await names({ events: ["login.granted"] })).toEqual(["login.granted"]);
    expect(await names({ events: ["otp."] })).toEqual(["otp.verified", "otp.verify_failed"]);
    expect(await names({ events: ["otp.verify_failed", "login."] })).toEqual([
      "login.granted",
      "login.not_authorized",
      "otp.verify_failed",
    ]);
    expect(await names({ method: "passkey" })).toEqual(["login.granted"]);
    expect(await names({ principalId: ali })).toEqual(expect.arrayContaining(["request.approved", "login.granted"]));
    expect(await names({ handle: "ip-handle-1" })).toEqual([
      "login.not_authorized",
      "otp.verified",
      "otp.verify_failed",
    ]);
    expect(await names({ handle: "subj-handle-1" })).toEqual(["otp.verify_failed"]);
    expect(await names({ since: new Date(Date.now() + 60_000) })).toEqual([]);
    expect((await names({ until: new Date(Date.now() + 60_000) })).length).toBeGreaterThan(4);
    const page = await store.searchAudit({ limit: 2 });
    expect(page.events).toHaveLength(2);
    const rest = await store.searchAudit({ before: page.next! });
    expect(rest.events[0]!.id).toBeLessThan(page.events[1]!.id);
  });

  it("counts per UTC day and event, open requests and active connections", async () => {
    const counts = await store.auditCounts(new Date(Date.now() - 86_400_000));
    const today = new Date().toISOString().slice(0, 10);
    expect(counts.perDay).toEqual(
      expect.arrayContaining([
        { day: today, event: "login.granted", n: 1 },
        { day: today, event: "request.approved", n: 1 },
      ]),
    );
    expect(counts.pendingRequests).toBe(0);
    expect(counts.activeConnections).toBe(2);
  });
});
