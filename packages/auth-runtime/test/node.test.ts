/**
 * UNIT tests of the plain Node adapter: a fake provider client and the in-memory store behind the real routes, cookies
 * and CORS handler, plus one pass over a real `node:http` listener. Not evidence of provider behaviour (see the
 * real-provider suite in core/identity/test).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { StepUpRequiredError, type SessionBounds } from "../src/index.ts";
import { createNodeAuth, createSessionStateHandler, type NodeAuthOptions } from "../src/node.ts";
import { createMemoryStore } from "../src/stores/memory.ts";
import { BOUNDS, ORIGIN, clock, containsAny, fakeOidc } from "./helpers.ts";

function setup(over: Partial<NodeAuthOptions> = {}, bounds: SessionBounds = BOUNDS) {
  const c = clock();
  const fake = fakeOidc(c, { expiresIn: 100_000 });
  const store = createMemoryStore({ clock: c.now });
  const logs: string[] = [];
  const auth = createNodeAuth({
    issuer: "https://id.example",
    clientId: "test-app",
    oidc: fake.client,
    origin: ORIGIN,
    store,
    flows: store,
    bounds,
    policies: ["management"],
    hooks: { authorize: async (_s, p) => p === "access" || p === "management" },
    deps: { now: c.now, sleep: async () => {}, log: (l) => logs.push(JSON.stringify(l)) },
    ...over,
  });
  return { auth, c, fake, store, logs };
}

const req = (path: string, init: RequestInit & { cookie?: string; origin?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.origin) headers.set("origin", init.origin);
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
};
const cookiesOf = (r: Response) => r.headers.getSetCookie();
const cookieValue = (r: Response, name: string) =>
  cookiesOf(r)
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0]
    ?.slice(name.length + 1);

async function login(t: ReturnType<typeof setup>, path = "/auth/start") {
  const start = (await t.auth.handleRequest(req(path)))!;
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const flow = cookieValue(start, "__Host-asafarim.flow")!;
  const cb = (await t.auth.handleRequest(
    req(`/auth/callback?code=good-code&state=${state}`, { cookie: `__Host-asafarim.flow=${flow}` }),
  ))!;
  return { start, cb, session: cookieValue(cb, "__Host-asafarim.sid"), flow };
}

describe("unit: node adapter routes", () => {
  it("ignores paths that are not its own", async () => {
    const { auth } = setup();
    expect(await auth.handleRequest(req("/"))).toBeNull();
    expect(await auth.handleRequest(req("/auth"))).toBeNull();
    expect(await auth.handleRequest(req("/auth/other"))).toBeNull();
  });

  it("start redirects to the provider with a host-only flow cookie, and nothing is cacheable", async () => {
    const { auth } = setup();
    const r = (await auth.handleRequest(req("/auth/start?return=/notes&fresh=1")))!;
    expect(r.status).toBe(303);
    expect(new URL(r.headers.get("location")!).origin).toBe("https://id.example");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const [c] = cookiesOf(r);
    expect(c).toMatch(
      /^__Host-asafarim\.flow=[A-Za-z0-9_-]{43}; Max-Age=600; Path=\/; Secure; HttpOnly; SameSite=Lax$/,
    );
    expect(c).not.toMatch(/domain/i);
  });

  it("a full sign-in sets the session cookie, clears the flow cookie, and lands on the validated return target", async () => {
    const t = setup();
    const { cb, session } = await login(t, "/auth/start?return=/notes%3Fa%3D1");
    expect(cb.status).toBe(303);
    expect(cb.headers.get("location")).toBe(`${ORIGIN}/notes?a=1`);
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const set = cookiesOf(cb);
    expect(set.find((c) => c.startsWith("__Host-asafarim.sid="))).toBe(
      `__Host-asafarim.sid=${session}; Max-Age=43200; Path=/; Secure; HttpOnly; SameSite=Lax`,
    );
    expect(set.find((c) => c.startsWith("__Host-asafarim.flow="))).toContain("Max-Age=0");
    const handle = await t.auth.current(req("/", { cookie: `__Host-asafarim.sid=${session}` }));
    expect(handle?.view.identityKey.sub).toBe("subject-1");
  });

  it("no open redirect: a hostile return target is dropped and the callback ignores a return parameter", async () => {
    const t = setup();
    for (const hostile of ["//evil.example", "https://evil.example/", "/\\evil.example", "javascript:alert(1)"]) {
      const { cb } = await login(t, `/auth/start?return=${encodeURIComponent(hostile)}`);
      expect(cb.headers.get("location")).toBe(`${ORIGIN}/`);
    }
    const start = (await t.auth.handleRequest(req("/auth/start?return=/ok")))!;
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cb = (await t.auth.handleRequest(
      req(`/auth/callback?code=good-code&state=${state}&return=https://evil.example/`, {
        cookie: `__Host-asafarim.flow=${cookieValue(start, "__Host-asafarim.flow")}`,
      }),
    ))!;
    expect(cb.headers.get("location")).toBe(`${ORIGIN}/ok`);
  });

  it("untrusted forwarded host headers change nothing: every URL comes from configuration", async () => {
    const t = setup();
    const start = (await t.auth.handleRequest(
      req("/auth/start?return=/x", {
        headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http", host: "evil.example" },
      }),
    ))!;
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cb = (await t.auth.handleRequest(
      req(`/auth/callback?code=good-code&state=${state}`, {
        cookie: `__Host-asafarim.flow=${cookieValue(start, "__Host-asafarim.flow")}`,
        headers: { "x-forwarded-host": "evil.example" },
      }),
    ))!;
    expect(cb.headers.get("location")).toBe(`${ORIGIN}/x`);
  });

  it("a callback without this browser's flow cookie, or replayed, fails with a code only and clears the flow cookie", async () => {
    const t = setup();
    const start = (await t.auth.handleRequest(req("/auth/start")))!;
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const noCookie = (await t.auth.handleRequest(req(`/auth/callback?code=good-code&state=${state}`)))!;
    expect(noCookie.status).toBe(400);
    expect(await noCookie.text()).toBe("Sign-in problem (invalid_state).");
    expect(cookiesOf(noCookie)[0]).toContain("Max-Age=0");
    const flow = cookieValue(start, "__Host-asafarim.flow");
    const ok = (await t.auth.handleRequest(
      req(`/auth/callback?code=good-code&state=${state}`, { cookie: `__Host-asafarim.flow=${flow}` }),
    ))!;
    expect(ok.status).toBe(303);
    const replay = (await t.auth.handleRequest(
      req(`/auth/callback?code=good-code&state=${state}`, { cookie: `__Host-asafarim.flow=${flow}` }),
    ))!;
    expect(replay.status).toBe(400);
  });

  it("only GET reaches start and callback; only POST reaches logout and back-channel logout", async () => {
    const { auth } = setup();
    expect((await auth.handleRequest(req("/auth/start", { method: "POST", origin: ORIGIN })))!.status).toBe(405);
    expect((await auth.handleRequest(req("/auth/callback", { method: "POST" })))!.status).toBe(405);
    expect((await auth.handleRequest(req("/auth/logout")))!.status).toBe(405);
    expect((await auth.handleRequest(req("/auth/logout/everywhere")))!.status).toBe(405);
    expect((await auth.handleRequest(req("/auth/backchannel-logout")))!.status).toBe(405);
  });
});

describe("unit: sign-out (labelled local vs everywhere), CSRF and origin checks", () => {
  const post = (path: string, o: { cookie?: string; origin?: string; body?: string } = {}) =>
    req(path, {
      method: "POST",
      cookie: o.cookie,
      origin: o.origin,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: o.body ?? "",
    });

  it("refuses a POST from another origin, with no Origin, or with a wrong or missing csrf value; keeps the session", async () => {
    const t = setup();
    const { session } = await login(t);
    const cookie = `__Host-asafarim.sid=${session}`;
    const csrf = (await t.auth.current(req("/", { cookie })))!.csrf;
    for (const [label, r] of [
      ["no origin", post("/auth/logout", { cookie, body: `csrf=${csrf}` })],
      ["other origin", post("/auth/logout", { cookie, origin: "https://evil.example", body: `csrf=${csrf}` })],
      ["suffix origin", post("/auth/logout", { cookie, origin: `${ORIGIN}.evil.example`, body: `csrf=${csrf}` })],
      ["no csrf", post("/auth/logout", { cookie, origin: ORIGIN })],
      ["wrong csrf", post("/auth/logout", { cookie, origin: ORIGIN, body: "csrf=nope" })],
      ["two csrf values", post("/auth/logout", { cookie, origin: ORIGIN, body: `csrf=${csrf}&csrf=${csrf}` })],
    ] as const) {
      const res = (await t.auth.handleRequest(r))!;
      expect(res.status, label).toBe(403);
    }
    expect(await t.auth.current(req("/", { cookie }))).not.toBeNull();
  });

  it("local logout ends this app's session and clears the cookie; the provider is not involved", async () => {
    const t = setup();
    const { session } = await login(t);
    const cookie = `__Host-asafarim.sid=${session}`;
    const csrf = (await t.auth.current(req("/", { cookie })))!.csrf;
    const res = (await t.auth.handleRequest(post("/auth/logout", { cookie, origin: ORIGIN, body: `csrf=${csrf}` })))!;
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/`);
    expect(cookiesOf(res)[0]).toContain("Max-Age=0");
    expect(await t.auth.current(req("/", { cookie }))).toBeNull();
  });

  it("logout everywhere ends the session first, then sends the browser to the provider's end-session URL", async () => {
    const t = setup();
    const { session } = await login(t);
    const cookie = `__Host-asafarim.sid=${session}`;
    const csrf = (await t.auth.current(req("/", { cookie })))!.csrf;
    const res = (await t.auth.handleRequest(
      post("/auth/logout/everywhere", { cookie, origin: ORIGIN, body: `csrf=${csrf}` }),
    ))!;
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://id.example/session/end");
    expect(loc.searchParams.get("post_logout_redirect_uri")).toBe(`${ORIGIN}/`);
    expect(await t.auth.current(req("/", { cookie }))).toBeNull();
  });

  it("logging out with no session is harmless and still needs the right origin", async () => {
    const { auth } = setup();
    expect((await auth.handleRequest(post("/auth/logout", { origin: ORIGIN })))!.status).toBe(303);
    expect((await auth.handleRequest(post("/auth/logout", { origin: "https://evil.example" })))!.status).toBe(403);
  });

  it("a body over the limit is refused before it is read in full", async () => {
    const t = setup();
    const { session } = await login(t);
    const res = (await t.auth.handleRequest(
      post("/auth/logout", {
        cookie: `__Host-asafarim.sid=${session}`,
        origin: ORIGIN,
        body: `csrf=${"a".repeat(10_000)}`,
      }),
    ))!;
    expect(res.status).toBe(413);
  });
});

describe("unit: back-channel logout endpoint", () => {
  const bc = (body: string | undefined) =>
    req("/auth/backchannel-logout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

  it("answers 200 for a valid token, 400 for replays, garbage, missing or duplicated parameters, 413 when oversize, with empty bodies", async () => {
    const t = setup();
    const { session } = await login(t);
    t.fake.state.logoutToken = { jti: "jti-1", iat: Math.floor(t.c.now() / 1000) + 1, sid: "sid-1" };
    const ok = (await t.auth.handleRequest(bc("logout_token=valid-logout-token")))!;
    expect(ok.status).toBe(200);
    expect(await t.auth.current(req("/", { cookie: `__Host-asafarim.sid=${session}` }))).toBeNull();
    for (const [label, body, status] of [
      ["replay", "logout_token=valid-logout-token", 400],
      ["garbage", "logout_token=garbage", 400],
      ["missing", "other=1", 400],
      ["empty", "", 400],
      ["duplicated", "logout_token=valid-logout-token&logout_token=valid-logout-token", 400],
      ["oversize", `logout_token=${"a".repeat(20_000)}`, 413],
    ] as const) {
      const r = (await t.auth.handleRequest(bc(body)))!;
      expect(r.status, label).toBe(status);
      expect(await r.text(), label).toBe("");
    }
  });

  it("answers 429 when the sender is over budget and 503 when the store is down", async () => {
    const limited = setup({ deps: { budget: async () => false, now: () => Date.now() } });
    expect((await limited.auth.handleRequest(bc("logout_token=valid-logout-token")))!.status).toBe(429);
    const t = setup();
    t.store.recordLogout = async () => {
      throw new Error("redis down");
    };
    t.fake.state.logoutToken = { jti: "j", iat: Math.floor(t.c.now() / 1000), sid: "sid-1" };
    expect((await t.auth.handleRequest(bc("logout_token=valid-logout-token")))!.status).toBe(503);
  });
});

describe("unit: session state endpoint and the cross-origin handler", () => {
  async function signedIn() {
    const t = setup();
    const { session } = await login(t);
    return { ...t, cookie: `__Host-asafarim.sid=${session}` };
  }

  it("same-origin /auth/session returns a minimal answer and never tokens, ids or the e-mail", async () => {
    const t = await signedIn();
    const anon = await (await t.auth.handleRequest(req("/auth/session")))!.json();
    expect(anon).toEqual({ status: "anonymous", authorized: { management: false }, fresh: false });
    const r = (await t.auth.handleRequest(req("/auth/session", { cookie: t.cookie })))!;
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ status: "active", authorized: { management: true }, fresh: true });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(
      containsAny(text, [...t.fake.state.issued, "person@example.test", "subject-1", t.cookie.split("=")[1]!]),
    ).toBeUndefined();
  });

  it("does not extend the idle window (a poll is not activity)", async () => {
    const t = await signedIn();
    for (let i = 0; i < 4; i++) {
      t.c.advance(10 * 60_000);
      await t.auth.handleRequest(req("/auth/session", { cookie: t.cookie }));
    }
    const r = (await (await t.auth.handleRequest(req("/auth/session", { cookie: t.cookie })))!.json()) as {
      status: string;
    };
    expect(r.status).toBe("anonymous");
  });

  it("says 'unavailable' (503), not 'signed out', when the store is down", async () => {
    const t = await signedIn();
    t.store.get = async () => {
      throw new Error("down");
    };
    const r = (await t.auth.handleRequest(req("/auth/session", { cookie: t.cookie })))!;
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ status: "unavailable" });
  });

  const PUBLIC = "https://www.example";
  it("CORS: exactly the allowed origin gets credentialed access; look-alikes, null and mixed case get 403 and no headers", async () => {
    const t = await signedIn();
    const handler = createSessionStateHandler({ auth: t.auth, allowedOrigins: [PUBLIC] });
    const ok = await handler(req("/x", { headers: { origin: PUBLIC, cookie: t.cookie } }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(PUBLIC);
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    expect(ok.headers.get("vary")).toBe("Origin");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const body = await ok.text();
    expect(JSON.parse(body)).toEqual({ status: "active", authorized: { management: true } });
    expect(containsAny(body, [...t.fake.state.issued, "person@example.test", "subject-1"])).toBeUndefined();
    for (const origin of [
      "https://www.example.evil.example",
      "https://evil.example",
      "null",
      "https://WWW.example",
      "http://www.example",
      `${PUBLIC}/`,
      "*",
      "https://www.example:444",
    ]) {
      const r = await handler(req("/x", { headers: { origin, cookie: t.cookie } }));
      expect(r.status, origin).toBe(403);
      expect(r.headers.get("access-control-allow-origin"), origin).toBeNull();
      expect(r.headers.get("access-control-allow-credentials"), origin).toBeNull();
      expect(await r.text(), origin).toBe("");
    }
  });

  it("CORS: no Origin header serves without CORS headers; OPTIONS answers only for allowed origins; other methods are 405", async () => {
    const t = await signedIn();
    const handler = createSessionStateHandler({ auth: t.auth, allowedOrigins: [PUBLIC] });
    const same = await handler(req("/x", { headers: { cookie: t.cookie } }));
    expect(same.status).toBe(200);
    expect(same.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await handler(req("/x", { method: "OPTIONS", headers: { origin: PUBLIC } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET");
    expect((await handler(req("/x", { method: "OPTIONS", headers: { origin: "https://evil.example" } }))).status).toBe(
      403,
    );
    expect((await handler(req("/x", { method: "POST", headers: { origin: PUBLIC } }))).status).toBe(405);
  });

  it("the header and a guarded route agree after the app's rule changes, with no stale grant", async () => {
    let allowed = true;
    const t = setup({ hooks: { authorize: async (_s, p) => p === "access" || (p === "management" && allowed) } });
    const { session } = await login(t);
    const cookie = `__Host-asafarim.sid=${session}`;
    const handler = createSessionStateHandler({ auth: t.auth, allowedOrigins: [PUBLIC] });
    const header = async () =>
      (
        (await (await handler(req("/x", { headers: { origin: PUBLIC, cookie } }))).json()) as {
          authorized: { management: boolean };
        }
      ).authorized.management;
    const guard = () =>
      t.auth.require(req("/", { cookie }), { policy: "management" }).then(
        () => true,
        () => false,
      );
    expect([await header(), await guard()]).toEqual([true, true]);
    allowed = false;
    expect([await header(), await guard()]).toEqual([false, false]);
  });
});

describe("unit: guards", () => {
  it("require() with fresh carries the restart URL for a step-up", async () => {
    const t = setup({}, { ...BOUNDS, revalidateMs: 3600_000 });
    const { session } = await login(t);
    const r = req("/", { cookie: `__Host-asafarim.sid=${session}` });
    t.c.advance(6 * 60_000);
    const err = await t.auth.require(r, { fresh: true, returnTo: "/billing" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepUpRequiredError);
    expect((err as StepUpRequiredError).restartUrl).toBe("/auth/start?return=%2Fbilling&fresh=1");
  });

  it("rejects bad configuration at construction", () => {
    for (const bad of [
      { prefix: "auth" },
      { prefix: "/" },
      { cookies: { session: "plain" } },
      { cookies: { session: "__Host-a", flow: "__Host-a" } },
      { origin: "http://app.example" },
    ])
      expect(() => setup(bad as Partial<NodeAuthOptions>), JSON.stringify(bad)).toThrow();
  });
});

describe("unit: over a real node:http listener", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it("serves start and the state endpoint, writing multiple Set-Cookie headers intact", async () => {
    const t = setup();
    server = createServer((rq, rs) => {
      t.auth.handle(rq, rs).then(
        (handled) => {
          if (!handled) {
            rs.writeHead(404);
            rs.end("not here");
          }
        },
        () => {
          rs.writeHead(500);
          rs.end();
        },
      );
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const start = await fetch(`${base}/auth/start?return=/a`, { redirect: "manual" });
    expect(start.status).toBe(303);
    expect(start.headers.get("location")).toContain("https://id.example/auth");
    expect(start.headers.getSetCookie()[0]).toContain("__Host-asafarim.flow=");
    expect((await fetch(`${base}/nothing`)).status).toBe(404);
    const s = await fetch(`${base}/auth/session`);
    expect(await s.json()).toMatchObject({ status: "anonymous" });
    const bc = await fetch(`${base}/auth/backchannel-logout`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "logout_token=garbage",
    });
    expect(bc.status).toBe(400);
  });
});
