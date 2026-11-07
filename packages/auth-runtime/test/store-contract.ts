import { describe, expect, it } from "vitest";
import { newId, type FlowStore, type SessionStore, type StoredSession } from "../src/index.ts";

export type Store = SessionStore & FlowStore;

export function session(over: Partial<StoredSession> = {}, nowMs = Date.now()): StoredSession {
  return {
    version: 1,
    identityKey: { iss: "https://id.example", sub: `sub-${newId().slice(0, 8)}` },
    sid: `sid-${newId().slice(0, 8)}`,
    authTime: Math.floor(nowMs / 1000),
    issuedAt: nowMs,
    expiresAt: nowMs + 12 * 3600_000,
    accessToken: `access-token-${newId()}`,
    refreshToken: `refresh-token-${newId()}`,
    accessExpiresAt: nowMs + 600_000,
    lastCheckedAt: nowMs,
    csrf: newId(),
    ...over,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The behaviour every SessionStore / FlowStore must have. The runtime depends on exactly this. */
export function describeStoreContract(label: string, make: () => Promise<Store>) {
  describe(`${label}: store contract`, () => {
    const now = Date.now();
    const read = (s: Store, id: string, o: Partial<{ touch: boolean; idleMs: number | null; now: number }> = {}) =>
      s.get(id, { touch: false, idleMs: null, now, ...o });

    it("creates and reads a session; a missing id is missing", async () => {
      const s = await make();
      const rec = session({}, now);
      const id = newId();
      expect(await s.create(id, rec, { now })).toBe(true);
      const r = await read(s, id);
      expect(r).toMatchObject({ status: "ok" });
      if (r.status === "ok") expect(r.session).toEqual(rec);
      expect(await read(s, newId())).toEqual({ status: "missing" });
    });

    it("applies the absolute bound and deletes the record", async () => {
      const s = await make();
      const id = newId();
      const rec = session({}, now);
      await s.create(id, rec, { now });
      expect(await read(s, id, { now: rec.expiresAt - 1 })).toMatchObject({ status: "ok" });
      expect(await read(s, id, { now: rec.expiresAt })).toEqual({ status: "expired" });
      expect(await read(s, id)).toEqual({ status: "missing" });
    });

    it("applies the idle bound; touch slides it, a non-touching read does not", async () => {
      const s = await make();
      const id = newId();
      await s.create(id, session({}, now), { now });
      const idle = 60_000;
      expect(await read(s, id, { idleMs: idle, now: now + 50_000, touch: true })).toMatchObject({ status: "ok" });
      expect(await read(s, id, { idleMs: idle, now: now + 100_000, touch: false })).toMatchObject({ status: "ok" }); // 50 s since the touch
      expect(await read(s, id, { idleMs: idle, now: now + 120_000, touch: false })).toEqual({ status: "idle" }); // 70 s since the touch
      expect(await read(s, id)).toEqual({ status: "missing" });
    });

    it("a back-channel logout by sid revokes sessions created at or before it, not later ones; the jti is single use", async () => {
      const s = await make();
      const older = session({ sid: "shared-sid" }, now);
      const olderId = newId();
      await s.create(olderId, older, { now });
      const logoutIat = Math.floor(now / 1000) + 5;
      expect(await s.recordLogout({ jti: "jti-1", iat: logoutIat, sid: "shared-sid", ttlMs: 3600_000 })).toBe(true);
      expect(await s.recordLogout({ jti: "jti-1", iat: logoutIat, sid: "shared-sid", ttlMs: 3600_000 })).toBe(false); // replay
      expect(await read(s, olderId)).toEqual({ status: "revoked" });
      expect(await read(s, olderId)).toEqual({ status: "missing" });
      // A session created after the logout is not touched by it.
      const later = session({ sid: "shared-sid", issuedAt: (logoutIat + 5) * 1000 }, (logoutIat + 5) * 1000);
      expect(await s.create(newId(), later, { now: later.issuedAt })).toBe(true);
      // A session being created that the logout already covers is refused.
      const covered = session({ sid: "shared-sid" }, now);
      expect(await s.create(newId(), covered, { now })).toBe(false);
    });

    it("a back-channel logout by sub revokes every session of that subject only", async () => {
      const s = await make();
      const mine = session({ identityKey: { iss: "https://id.example", sub: "person-a" }, sid: "sid-a" }, now);
      const other = session({ identityKey: { iss: "https://id.example", sub: "person-b" }, sid: "sid-b" }, now);
      const [a, b] = [newId(), newId()];
      await s.create(a, mine, { now });
      await s.create(b, other, { now });
      await s.recordLogout({ jti: "jti-sub", iat: Math.floor(now / 1000) + 1, sub: "person-a", ttlMs: 3600_000 });
      expect(await read(s, a)).toEqual({ status: "revoked" });
      expect(await read(s, b)).toMatchObject({ status: "ok" });
    });

    it("update succeeds only with the held lock, on a live session", async () => {
      const s = await make();
      const id = newId();
      const rec = session({}, now);
      await s.create(id, rec, { now });
      const next = { ...rec, accessToken: "access-token-rotated-xxxxxxxx" };
      expect(await s.update(id, next, { token: "no-lock-held" }, { now })).toBe(false);
      const lock = await s.acquireRefresh(id, 5000);
      expect(lock).not.toBeNull();
      expect(await s.update(id, next, { token: "someone-else" }, { now })).toBe(false);
      expect(await s.update(id, next, lock!, { now })).toBe(true);
      const r = await read(s, id);
      if (r.status === "ok") expect(r.session.accessToken).toBe(next.accessToken);
      await s.releaseRefresh(id, lock!);
      expect(await s.update(id, next, lock!, { now })).toBe(false); // lock released
      await s.destroy(id);
      const lock2 = await s.acquireRefresh(id, 5000);
      expect(await s.update(id, next, lock2!, { now })).toBe(false); // session gone
    });

    it("update refuses a session revoked meanwhile", async () => {
      const s = await make();
      const id = newId();
      const rec = session({ sid: "sid-race" }, now);
      await s.create(id, rec, { now });
      const lock = (await s.acquireRefresh(id, 5000))!;
      await s.recordLogout({ jti: "jti-race", iat: Math.floor(now / 1000) + 1, sid: "sid-race", ttlMs: 60_000 });
      expect(await s.update(id, rec, lock, { now })).toBe(false);
    });

    it("the refresh lock is exclusive, renewable by its owner only, and lapses with its lease", async () => {
      const s = await make();
      const id = newId();
      const a = await s.acquireRefresh(id, 80);
      expect(a).not.toBeNull();
      expect(await s.acquireRefresh(id, 80)).toBeNull();
      expect(await s.renewRefresh(id, { token: "other" }, 80)).toBe(false);
      expect(await s.renewRefresh(id, a!, 200)).toBe(true);
      await sleep(120);
      expect(await s.acquireRefresh(id, 80)).toBeNull(); // renewed to 200 ms
      await sleep(150);
      const b = await s.acquireRefresh(id, 80);
      expect(b).not.toBeNull(); // lapsed
      expect(await s.renewRefresh(id, a!, 80)).toBe(false); // the old owner has lost it
      await s.releaseRefresh(id, a!); // releasing someone else's lock does nothing
      expect(await s.acquireRefresh(id, 80)).toBeNull();
      await s.releaseRefresh(id, b!);
      expect(await s.acquireRefresh(id, 80)).not.toBeNull();
    });

    it("exactly one of many concurrent acquirers gets the lock", async () => {
      const s = await make();
      const id = newId();
      const got = await Promise.all(Array.from({ length: 25 }, () => s.acquireRefresh(id, 2000)));
      expect(got.filter(Boolean)).toHaveLength(1);
    });

    it("flows are single use and expire", async () => {
      const s = await make();
      const flow = { state: "s", nonce: "n", verifier: "v".repeat(43), returnTo: "/x", fresh: false, createdAt: now };
      const id = newId();
      await s.put(id, flow, 5000);
      expect(await s.take(id)).toEqual(flow);
      expect(await s.take(id)).toBeNull();
      const id2 = newId();
      await s.put(id2, flow, 40);
      await sleep(90);
      expect(await s.take(id2)).toBeNull();
      expect(await s.take(newId())).toBeNull();
    });
  });
}
