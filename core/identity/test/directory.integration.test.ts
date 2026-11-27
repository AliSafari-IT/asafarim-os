/**
 * The people directory behind the Admin console's Users page (PgIdentityStore.directory and directoryProfile) on a
 * real Postgres (IDENTITY_TEST_DATABASE_URL, a login that may CREATE DATABASE), in a throwaway database.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DirectoryCursorError, PgIdentityStore } from "../src/store.ts";
import { pid } from "./fakes.ts";

const DATABASE_URL = process.env.IDENTITY_TEST_DATABASE_URL;
if (process.env.CI && !DATABASE_URL) throw new Error("IDENTITY_TEST_DATABASE_URL must be set in CI");

describe.skipIf(!DATABASE_URL)("the people directory (Postgres)", () => {
  const dbName = `identity_directory_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let store: PgIdentityStore;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(DATABASE_URL!);
    u.pathname = `/${dbName}`;
    store = new PgIdentityStore(u.href);
    await store.migrate();
    // ali: the bootstrap admin (global). sam: asked for access, nothing yet. pat: a public sign-up at knowledge.
    // rex: had access, then suspended. gwen: signed in with Google (only her Google email is searchable).
    await store.bootstrapAdmin([{ method: "email", identifier: "ali@example.test" }]);
    ids.ali = await pid(store.verifiedLogin("email", "ali@example.test"));
    ids.sam = await pid(store.verifiedLogin("email", "sam@example.test"));
    await store.requestConnection(ids.sam);
    ids.pat = await pid(store.verifiedLogin("email", "pat@example.test"));
    expect(await store.admitPublic(ids.pat, "knowledge")).toBe("admitted");
    ids.rex = await store.addConnection("email", "rex@example.test", ids.ali);
    expect(await store.revoke(ids.rex, ids.ali)).toBe(true);
    ids.gwen = await pid(store.verifiedGoogleLogin("google-subject-1234567890", "gwen@example.test", false));
  });

  afterAll(async () => {
    await store?.close();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  const labels = async (f: Parameters<PgIdentityStore["directory"]>[0]) =>
    (await store.directory(f)).users.map((u) => u.label);

  it("lists everyone by label, with state, admission scope and email verification", async () => {
    const { users, next } = await store.directory({});
    expect(next).toBeNull();
    expect(users.map((u) => u.label)).toEqual([
      "ali@example.test",
      "gwen@example.test",
      "pat@example.test",
      "rex@example.test",
      "sam@example.test",
    ]);
    const by = Object.fromEntries(users.map((u) => [u.label, u]));
    expect(by["ali@example.test"]).toMatchObject({
      state: "active",
      scope: "global",
      isAdmin: true,
      emailVerified: true,
    });
    expect(by["pat@example.test"]).toMatchObject({ state: "active", scope: "apps", admittedClients: ["knowledge"] });
    expect(by["sam@example.test"]).toMatchObject({ state: "active", scope: "none" });
    // rex's address was typed in by an admin and never proved.
    expect(by["rex@example.test"]).toMatchObject({ state: "suspended", scope: "none", emailVerified: false });
  });

  it("finds by part of an address or an exact id, exact matches first; never by Google's internal subject", async () => {
    expect(await labels({ q: "PAT@" })).toEqual(["pat@example.test"]);
    expect(await labels({ q: ids.rex! })).toEqual(["rex@example.test"]);
    expect(await labels({ q: ids.rex!.toUpperCase() })).toEqual(["rex@example.test"]);
    expect(await labels({ q: "gwen@example.test" })).toEqual(["gwen@example.test"]);
    expect(await labels({ q: "google-subject" })).toEqual([]);
    // LIKE wildcards in the text are literal.
    expect(await labels({ q: "%" })).toEqual([]);
    expect(await labels({ q: "_" })).toEqual([]);
    // "sam@example.test" matches sam exactly and nobody else partially; "example.test" matches all, none exactly.
    expect((await labels({ q: "example.test" })).length).toBe(5);
    expect(await labels({ q: "sam@example.test" })).toEqual(["sam@example.test"]);
  });

  it("filters by account state and admission scope", async () => {
    expect(await labels({ state: "suspended" })).toEqual(["rex@example.test"]);
    expect(await labels({ state: "active", scope: "apps" })).toEqual(["pat@example.test"]);
    expect(await labels({ scope: "global" })).toEqual(["ali@example.test"]);
    expect(await labels({ scope: "none", state: "active" })).toEqual(["gwen@example.test", "sam@example.test"]);
  });

  it("pages deterministically with the cursor: every person once, in order, also for exact-match ranking", async () => {
    for (const q of [undefined, "example"]) {
      const seen: string[] = [];
      let after: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await store.directory({ limit: 2, ...(q ? { q } : {}), ...(after ? { after } : {}) });
        seen.push(...page.users.map((u) => u.id));
        if (!page.next) break;
        after = page.next;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    }
    await expect(store.directory({ after: "garbage" })).rejects.toBeInstanceOf(DirectoryCursorError);
    await expect(store.directory({ after: Buffer.from('{"r":0}').toString("base64url") })).rejects.toBeInstanceOf(
      DirectoryCursorError,
    );
  });

  it("one person's profile: identities, connection, admissions and an open request", async () => {
    const sam = (await store.directoryProfile(ids.sam!))!;
    expect(sam).toMatchObject({ label: "sam@example.test", state: "active", scope: "none", connection: null });
    expect(sam.identities).toEqual([
      expect.objectContaining({ method: "email", identifier: "sam@example.test", verifiedAt: expect.any(Date) }),
    ]);
    expect(sam.pendingRequest).toMatchObject({ apps: [] });

    const rex = (await store.directoryProfile(ids.rex!))!;
    expect(rex.connection).toMatchObject({ status: "revoked", source: "admin", revokedBy: ids.ali });
    const pat = (await store.directoryProfile(ids.pat!))!;
    expect(pat.admissions).toEqual([{ clientId: "knowledge", source: "public_signup", grantedAt: expect.any(Date) }]);
    const gwen = (await store.directoryProfile(ids.gwen!))!;
    expect(gwen.identities[0]).toMatchObject({ method: "google", identifier: "gwen@example.test" });
    expect(JSON.stringify(gwen)).not.toContain("google-subject");

    expect(await store.directoryProfile("0190b6c4-0000-7000-8000-00000000ffff")).toBeNull();
    expect(await store.directoryProfile("not-an-id")).toBeNull();
  });
});
