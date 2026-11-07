/**
 * An in-memory store with the same semantics as the Redis one. For unit tests, development and a single process only:
 * it is not shared between processes and loses everything on restart. Tests that use it are labelled "unit".
 */
import { randomBytes } from "node:crypto";
import type {
  Flow,
  FlowStore,
  LockToken,
  LogoutRecord,
  SessionStore,
  StoredSession,
  StoreReadResult,
} from "../types.ts";

interface Entry {
  s: StoredSession;
  seen: number;
}

export interface MemoryStore extends SessionStore, FlowStore {
  readonly size: number;
  /** Test helper: drop the refresh lock as if its lease had lapsed or another process had taken over. */
  dropLock(id: string): void;
}

export function createMemoryStore(o: { clock?: () => number } = {}): MemoryStore {
  const clock = o.clock ?? Date.now;
  const sessions = new Map<string, Entry>();
  const locks = new Map<string, { token: string; until: number }>();
  const flows = new Map<string, { flow: Flow; until: number }>();
  const jtis = new Map<string, number>();
  const bySid = new Map<string, { iat: number; until: number }>();
  const bySub = new Map<string, { iat: number; until: number }>();

  const marker = (m: Map<string, { iat: number; until: number }>, k: string | undefined) => {
    if (!k) return undefined;
    const v = m.get(k);
    if (!v) return undefined;
    if (v.until <= clock()) {
      m.delete(k);
      return undefined;
    }
    return v.iat;
  };
  const revoked = (s: StoredSession): boolean => {
    const since = Math.floor(s.issuedAt / 1000);
    const a = marker(bySid, s.sid);
    const b = marker(bySub, s.identityKey.sub);
    return (a !== undefined && a >= since) || (b !== undefined && b >= since);
  };
  const liveLock = (id: string) => {
    const l = locks.get(id);
    if (l && l.until <= clock()) {
      locks.delete(id);
      return undefined;
    }
    return l;
  };

  return {
    get size() {
      return sessions.size;
    },
    dropLock: (id) => void locks.delete(id),

    async get(id, { touch, idleMs, now }): Promise<StoreReadResult> {
      const e = sessions.get(id);
      if (!e) return { status: "missing" };
      if (now >= e.s.expiresAt) {
        sessions.delete(id);
        return { status: "expired" };
      }
      if (revoked(e.s)) {
        sessions.delete(id);
        return { status: "revoked" };
      }
      if (idleMs !== null && now - e.seen >= idleMs) {
        sessions.delete(id);
        return { status: "idle" };
      }
      if (touch) e.seen = now;
      return { status: "ok", session: structuredClone(e.s) };
    },
    async create(id, s, { now }) {
      if (revoked(s)) return false;
      sessions.set(id, { s: structuredClone(s), seen: now });
      return true;
    },
    async update(id, s, lock, { now }) {
      const e = sessions.get(id);
      const l = liveLock(id);
      if (!e || !l || l.token !== lock.token) return false;
      if (revoked(e.s)) {
        sessions.delete(id);
        return false;
      }
      sessions.set(id, { s: structuredClone(s), seen: e.seen });
      void now;
      return true;
    },
    async destroy(id) {
      sessions.delete(id);
      locks.delete(id);
    },
    async acquireRefresh(id, leaseMs): Promise<LockToken | null> {
      if (liveLock(id)) return null;
      const token = randomBytes(16).toString("base64url");
      locks.set(id, { token, until: clock() + leaseMs });
      return { token };
    },
    async renewRefresh(id, lock, leaseMs) {
      const l = liveLock(id);
      if (!l || l.token !== lock.token) return false;
      l.until = clock() + leaseMs;
      return true;
    },
    async releaseRefresh(id, lock) {
      if (locks.get(id)?.token === lock.token) locks.delete(id);
    },
    async recordLogout(r: LogoutRecord) {
      const until = clock() + r.ttlMs;
      const seen = jtis.get(r.jti);
      if (seen !== undefined && seen > clock()) return false;
      jtis.set(r.jti, until);
      for (const [m, k] of [
        [bySid, r.sid],
        [bySub, r.sub],
      ] as const) {
        if (!k) continue;
        const prev = m.get(k);
        m.set(k, { iat: Math.max(prev?.iat ?? 0, r.iat), until: Math.max(prev?.until ?? 0, until) });
      }
      return true;
    },

    async put(id, flow, ttlMs) {
      flows.set(id, { flow: structuredClone(flow), until: clock() + ttlMs });
    },
    async take(id) {
      const f = flows.get(id);
      flows.delete(id);
      return f && f.until > clock() ? f.flow : null;
    },
  };
}
