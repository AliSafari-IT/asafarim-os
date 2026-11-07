/**
 * Contract/security tests that run against BOTH adapters (acceptance 1). Each row states a rule; for each adapter it is
 * either proved, or (where the adapter cannot have the behaviour) asserted as an explicit, documented GAP, never skipped.
 *
 *  - "node": the plain Node adapter, with a fake provider and the in-memory store (UNIT).
 *  - "authjs": the configuration returned by `asafarimAuthConfig`, exercised through its callbacks (UNIT). Auth.js itself
 *    (next-auth) is not a dependency of this package; its own checks (PKCE, state, nonce) are configured, not run here.
 *
 * The real-provider behaviour is covered by core/identity/test/auth-runtime.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  asafarimAuthConfig,
  IDENTITY_SESSION_SECONDS,
  SESSION_COOKIE_NAME,
  withForwardedOrigin,
} from "../src/authjs.ts";
import { createNodeAuth } from "../src/node.ts";
import { createMemoryStore } from "../src/stores/memory.ts";
import { BOUNDS, ORIGIN, clock, containsAny, fakeOidc } from "./helpers.ts";

interface Cookie {
  name: string;
  attrs: string[];
}
interface Subject {
  name: "node" | "authjs";
  /** The session cookie as the adapter configures/sets it. */
  sessionCookie(): Promise<Cookie>;
  /** What the browser-facing session object contains after a sign-in with these tokens. */
  browserFacing(tokens: { access: string; refresh: string; id: string }): Promise<string>;
  /** Is a session that signed in `ageMs` ago still valid, given an absolute bound of `boundMs`? */
  validAfter(ageMs: number, boundMs: number): Promise<boolean>;
  /** Is a session idle for `idleMs` (bound 30 min) still valid? Adapters without an idle bound say so. */
  validAfterIdle(idleMs: number): Promise<boolean>;
  /** Does the adapter let a browser-supplied amr/acr/auth-method label influence the session? */
  browserAmrInfluences(): Promise<boolean>;
  capabilities: {
    idle: boolean;
    backchannel: boolean;
    stepUp: boolean;
    refreshLock: boolean;
    providerRecheck: boolean;
  };
}

const parseCookie = (setCookie: string): Cookie => {
  const [pair, ...attrs] = setCookie.split(";").map((p) => p.trim());
  return { name: pair!.split("=")[0]!, attrs };
};

async function nodeSubject(): Promise<Subject> {
  const make = (bounds = BOUNDS, expiresIn = 100_000) => {
    const c = clock();
    const fake = fakeOidc(c, { expiresIn });
    const store = createMemoryStore({ clock: c.now });
    const auth = createNodeAuth({
      issuer: "https://id.example",
      clientId: "test-app",
      oidc: fake.client,
      origin: ORIGIN,
      store,
      flows: store,
      bounds,
      deps: { now: c.now, sleep: async () => {} },
    });
    return { c, fake, auth };
  };
  const signIn = async (t: ReturnType<typeof make>, extraQuery = "") => {
    const start = (await t.auth.handleRequest(new Request(`${ORIGIN}/auth/start`)))!;
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const flow = start.headers.getSetCookie()[0]!.split(";")[0]!;
    const cb = (await t.auth.handleRequest(
      new Request(`${ORIGIN}/auth/callback?code=good-code&state=${state}${extraQuery}`, { headers: { cookie: flow } }),
    ))!;
    const sid = cb.headers.getSetCookie().find((x) => x.startsWith("__Host-asafarim.sid="))!;
    return { cb, sid, cookie: sid.split(";")[0]! };
  };
  return {
    name: "node",
    capabilities: { idle: true, backchannel: true, stepUp: true, refreshLock: true, providerRecheck: true },
    async sessionCookie() {
      return parseCookie((await signIn(make())).sid);
    },
    async browserFacing() {
      const t = make();
      const { cookie } = await signIn(t);
      const r = (await t.auth.handleRequest(new Request(`${ORIGIN}/auth/session`, { headers: { cookie } })))!;
      return `${await r.text()}\n${cookie}\n${[...r.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}`;
    },
    async validAfter(ageMs, boundMs) {
      const t = make({
        ...BOUNDS,
        absoluteMs: boundMs,
        idleMs: null,
        freshMs: Math.min(BOUNDS.freshMs, boundMs),
        revalidateMs: Math.min(BOUNDS.revalidateMs, boundMs),
      });
      const { cookie } = await signIn(t);
      t.c.advance(ageMs);
      return (await t.auth.current(new Request(ORIGIN, { headers: { cookie } }), { touch: false })) !== null;
    },
    async validAfterIdle(idleMs) {
      const t = make({ ...BOUNDS, revalidateMs: BOUNDS.absoluteMs });
      const { cookie } = await signIn(t);
      t.c.advance(idleMs);
      return (await t.auth.current(new Request(ORIGIN, { headers: { cookie } }), { touch: false })) !== null;
    },
    async browserAmrInfluences() {
      const t = make();
      const { cookie } = await signIn(t, "&amr=pwd&acr=3&auth_time=1");
      const h = await t.auth.current(new Request(ORIGIN, { headers: { cookie } }));
      return h!.view.amr?.[0] !== "otp" || h!.view.acr !== "1";
    },
  };
}

function authjsSubject(): Subject {
  const NOW = new Date("2026-10-19T10:00:00Z");
  const cfgFor = (maxAge?: number) =>
    asafarimAuthConfig({
      issuer: "https://id.example",
      clientId: "test-app",
      ...(maxAge ? { sessionMaxAgeSeconds: maxAge } : {}),
    });
  const jwt = (cfg: ReturnType<typeof cfgFor>, args: object) =>
    (cfg.callbacks.jwt as (a: object) => Record<string, unknown> | null)(args);
  return {
    name: "authjs",
    capabilities: { idle: false, backchannel: false, stepUp: false, refreshLock: false, providerRecheck: false },
    async sessionCookie() {
      const o = cfgFor().cookies.sessionToken;
      return {
        name: o.name,
        attrs: [
          "Path=" + o.options.path,
          ...(o.options.secure ? ["Secure"] : []),
          ...(o.options.httpOnly ? ["HttpOnly"] : []),
          "SameSite=" + o.options.sameSite[0]!.toUpperCase() + o.options.sameSite.slice(1),
        ],
      };
    },
    async browserFacing(tokens) {
      const cfg = cfgFor();
      const token = jwt(cfg, {
        token: {},
        profile: { sub: "subject-1", roles: ["member"] },
        account: { id_token: tokens.id, access_token: tokens.access, refresh_token: tokens.refresh },
      })!;
      return JSON.stringify((cfg.callbacks.session as (a: object) => unknown)({ session: { user: {} }, token }));
    },
    async validAfter(ageMs, boundMs) {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(NOW);
        const cfg = cfgFor(boundMs / 1000);
        const token = jwt(cfg, { token: {}, profile: { sub: "s" }, account: { id_token: "a.b.c" } })!;
        vi.setSystemTime(new Date(NOW.getTime() + ageMs));
        return jwt(cfg, { token }) !== null;
      } finally {
        vi.useRealTimers();
      }
    },
    async validAfterIdle(idleMs) {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(NOW);
        const cfg = cfgFor();
        const token = jwt(cfg, { token: {}, profile: { sub: "s" }, account: { id_token: "a.b.c" } })!;
        vi.setSystemTime(new Date(NOW.getTime() + idleMs));
        return jwt(cfg, { token }) !== null;
      } finally {
        vi.useRealTimers();
      }
    },
    async browserAmrInfluences() {
      const cfg = cfgFor();
      const token = jwt(cfg, {
        token: {},
        profile: { sub: "s", amr: ["pwd"], acr: "3" },
        account: { id_token: "a.b.c" },
      })!;
      return "amr" in token || "acr" in token;
    },
  };
}

const subjects: Subject[] = [await nodeSubject(), authjsSubject()];

describe.each(subjects.map((s) => [s.name, s] as const))("contract: %s adapter", (_name, s) => {
  it("session cookie is host-only: __Host- prefix, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain", async () => {
    const c = await s.sessionCookie();
    expect(c.name.startsWith("__Host-")).toBe(true);
    expect(c.attrs).toEqual(expect.arrayContaining(["Path=/", "Secure", "HttpOnly", "SameSite=Lax"]));
    expect(c.attrs.some((a) => /^domain=/i.test(a))).toBe(false);
  });

  it("the browser-facing session holds no token", async () => {
    const tokens = { access: "access-token-AAAAAAAA", refresh: "refresh-token-BBBBBBBB", id: "id.token.CCCCCCCC" };
    const out = await s.browserFacing(tokens);
    expect(containsAny(out, Object.values(tokens))).toBeUndefined();
  });

  it("enforces the absolute bound exactly", async () => {
    expect(await s.validAfter(3599_000, 3600_000)).toBe(true);
    expect(await s.validAfter(3600_000, 3600_000)).toBe(false);
    expect(await s.validAfter(7200_000, 3600_000)).toBe(false);
  });

  it("an authentication-method label from the browser cannot become evidence", async () => {
    expect(await s.browserAmrInfluences()).toBe(false);
  });

  if (s.capabilities.idle) {
    it("enforces the idle bound", async () => {
      expect(await s.validAfterIdle(29 * 60_000)).toBe(true);
      expect(await s.validAfterIdle(31 * 60_000)).toBe(false);
    });
  } else {
    it("GAP (documented): a stateless Auth.js JWT session has no idle bound, only the absolute one", async () => {
      expect(await s.validAfterIdle(11 * 3600_000)).toBe(true);
    });
  }

  if (!s.capabilities.stepUp) {
    it("GAP (documented): the Auth.js configuration asks for no freshness (no max_age / prompt), so it cannot require step-up", () => {
      const p = asafarimAuthConfig({ issuer: "https://id.example", clientId: "test-app" }).providers[0]!;
      expect(Object.keys(p.authorization.params)).toEqual(["scope"]);
    });
  }

  if (!s.capabilities.backchannel) {
    it("GAP (documented): no back-channel logout, refresh lock or provider re-check: the callbacks are pure and never call the provider", () => {
      const cfg = asafarimAuthConfig({ issuer: "https://id.example", clientId: "test-app" });
      expect(Object.keys(cfg.callbacks).sort()).toEqual(["jwt", "session"]);
      const out = (cfg.callbacks.jwt as (a: object) => unknown)({
        token: { signedInAt: Math.floor(Date.now() / 1000) },
        profile: undefined,
      });
      expect(out).not.toBeInstanceOf(Promise); // nothing asynchronous, so nothing that could fall back permissively on an outage
      // Equivalence, not new guarantees: S2 keeps Auth.js apps exactly as they were.
      expect(cfg.session).toEqual({ strategy: "jwt", maxAge: IDENTITY_SESSION_SECONDS });
    });
  }
});

describe("contract: forwarded host handling", () => {
  const headers = (h: Record<string, string>) => ({ headers: h });

  it("authjs: only a well-formed forwarded host is honoured, exactly as before (trustHost: true behind the gateway)", () => {
    const r = withForwardedOrigin(
      new Request(
        "http://localhost:4100/x",
        headers({ "x-forwarded-host": "docs.asafarim.site", "x-forwarded-proto": "https" }),
      ),
    );
    expect(r.url).toBe("https://docs.asafarim.site/x");
    for (const bad of ["evil.example/x", "a@evil.example", "evil example", ".evil.example", "evil.example:99999999a"]) {
      expect(
        withForwardedOrigin(new Request("http://localhost:4100/x", headers({ "x-forwarded-host": bad }))).url,
        bad,
      ).toBe("http://localhost:4100/x");
    }
  });

  it("node: forwarded headers are ignored altogether; every URL comes from configuration", async () => {
    const c = clock();
    const store = createMemoryStore({ clock: c.now });
    const auth = createNodeAuth({
      issuer: "https://id.example",
      clientId: "test-app",
      oidc: fakeOidc(c).client,
      origin: ORIGIN,
      store,
      flows: store,
      bounds: BOUNDS,
      deps: { now: c.now },
    });
    const r = (await auth.handleRequest(
      new Request(`${ORIGIN}/auth/start`, {
        headers: { "x-forwarded-host": "docs.asafarim.site", "x-forwarded-proto": "https", host: "evil.example" },
      }),
    ))!;
    expect(r.status).toBe(303);
    expect(auth.paths.callback).toBe("/auth/callback");
  });
});

describe("contract: authjs adapter keeps its public constants", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("exports the cookie name and lifetime unchanged", () => {
    expect(SESSION_COOKIE_NAME).toBe("__Host-asafarim.session-token");
    expect(IDENTITY_SESSION_SECONDS).toBe(43_200);
  });
});
