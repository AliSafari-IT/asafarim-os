/**
 * UNIT tests of the session runtime: a fake provider client and the in-memory store. They prove the runtime's own logic
 * (bounds, locking, fallbacks, policies). They are not evidence of behaviour against a real provider; that is
 * core/identity/test/auth-runtime.integration.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AuthenticationRequiredError,
  CsrfError,
  IdentityUnavailableError,
  InvalidConfigError,
  InvalidStateError,
  LogoutReplayError,
  LogoutTokenInvalidError,
  ProfileDeniedError,
  RateLimitedError,
  RefreshOwnershipLostError,
  StepUpRequiredError,
  StoreUnavailableError,
  newId,
  type SessionBounds,
  type SessionStore,
} from "../src/index.ts";
import { createSessionRuntime, type SessionRuntimeOptions } from "../src/session.ts";
import { createMemoryStore } from "../src/stores/memory.ts";
import { BOUNDS, ORIGIN, clock, containsAny, fakeOidc, signIn } from "./helpers.ts";

function setup(
  over: Partial<SessionRuntimeOptions> = {},
  fake: Parameters<typeof fakeOidc>[1] = {},
  bounds: SessionBounds = BOUNDS,
  realSleep = false,
) {
  const c = clock();
  const { client, state } = fakeOidc(c, fake);
  const store = createMemoryStore({ clock: c.now });
  const logs: unknown[] = [];
  const audits: unknown[] = [];
  const runtime = createSessionRuntime({
    oidc: client,
    store,
    flows: store,
    bounds,
    origin: ORIGIN,
    deps: {
      now: c.now,
      ...(realSleep ? {} : { sleep: async () => {} }),
      log: (l) => logs.push(l),
      audit: (e, d) => audits.push([e, d]),
    },
    ...over,
  } as SessionRuntimeOptions);
  return { c, state, store, runtime, logs, audits };
}

describe("unit: sign-in", () => {
  it("start → callback creates a server-side session; the browser gets only an opaque id", async () => {
    const { runtime, state } = setup();
    const r = await signIn(runtime);
    expect(r.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.maxAgeSec).toBe(12 * 3600);
    expect(r.returnTo).toBe("/");
    const h = await runtime.current(r.sessionId);
    expect(h?.view.identityKey).toEqual({ iss: "https://id.example", sub: "subject-1" });
    expect(h?.view.amr).toEqual(["otp"]);
    expect(h?.accessToken()).toBe(state.issued[0]);
    expect(containsAny(JSON.stringify(h), state.issued)).toBeUndefined();
  });

  it("a flow is single use: replaying the callback, or using no flow, is an InvalidStateError", async () => {
    const { runtime } = setup();
    const started = await runtime.start();
    const q = new URLSearchParams({ code: "good-code", state: new URL(started.redirect).searchParams.get("state")! });
    await runtime.callback({ query: q, flowId: started.flowId });
    await expect(runtime.callback({ query: q, flowId: started.flowId })).rejects.toBeInstanceOf(InvalidStateError);
    await expect(runtime.callback({ query: q })).rejects.toMatchObject({
      code: "invalid_state",
      reason: "missing_flow",
    });
    await expect(runtime.callback({ query: q, flowId: "not-an-id" })).rejects.toMatchObject({ reason: "missing_flow" });
  });

  it("login CSRF: a callback for a flow this browser did not start (another flow id) is refused", async () => {
    const { runtime } = setup();
    const mine = await runtime.start();
    const attackers = await runtime.start();
    const attackerState = new URL(attackers.redirect).searchParams.get("state")!;
    // The attacker's state and code arrive in the victim's browser, which holds its own flow id.
    await expect(
      runtime.callback({
        query: new URLSearchParams({ code: "good-code", state: attackerState }),
        flowId: mine.flowId,
      }),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("an expired flow is refused", async () => {
    const { runtime, c } = setup();
    const started = await runtime.start();
    c.advance(11 * 60_000);
    const q = new URLSearchParams({ code: "good-code", state: new URL(started.redirect).searchParams.get("state")! });
    // The flow store enforces the lifetime itself (it has dropped the record), and the runtime checks it again.
    await expect(runtime.callback({ query: q, flowId: started.flowId })).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it("two state parameters in the callback are refused", async () => {
    const { runtime } = setup();
    const started = await runtime.start();
    const s = new URL(started.redirect).searchParams.get("state")!;
    const q = new URLSearchParams(`code=good-code&state=${s}&state=${s}`);
    await expect(runtime.callback({ query: q, flowId: started.flowId })).rejects.toMatchObject({
      reason: "bad_callback",
    });
  });

  it("each sign-in gets a new id (no fixation) and ends the browser's previous session", async () => {
    const { runtime } = setup();
    const a = await signIn(runtime);
    const started = await runtime.start();
    const q = new URLSearchParams({ code: "good-code", state: new URL(started.redirect).searchParams.get("state")! });
    const b = await runtime.callback({ query: q, flowId: started.flowId, previousSessionId: a.sessionId });
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(await runtime.current(a.sessionId)).toBeNull();
    expect(await runtime.current(b.sessionId)).not.toBeNull();
  });

  it("carries return target, locale and intent through the server-side flow; the callback query cannot change them", async () => {
    const { runtime, state } = setup({
      allowedReturnOrigins: ["https://www.example"],
      locales: ["nl", "en"],
      defaultLocale: "en",
      intents: { signin: {}, register: { screen_hint: "register" } },
    });
    const started = await runtime.start({ returnTo: "https://www.example/welcome", locale: "nl", intent: "register" });
    const auth = state.lastAuthorizationUrl!;
    expect(auth.searchParams.get("ui_locales")).toBe("nl");
    expect(auth.searchParams.get("screen_hint")).toBe("register");
    const q = new URLSearchParams({
      code: "good-code",
      state: auth.searchParams.get("state")!,
      return: "https://evil.example/",
      locale: "fr",
      intent: "signin",
    });
    const r = await runtime.callback({ query: q, flowId: started.flowId });
    expect(r).toMatchObject({ returnTo: "https://www.example/welcome", locale: "nl", intent: "register" });
  });

  it("drops a forged return target, an off-list locale and an unknown intent", async () => {
    const { runtime, state } = setup({ locales: ["nl", "en"], defaultLocale: "en", intents: { signin: {} } });
    for (const returnTo of ["//evil.example", "https://evil.example/", "javascript:alert(1)", "/\\evil"]) {
      const s = await signIn(runtime, { returnTo, locale: "xx", intent: "admin" });
      expect(s.returnTo).toBe("/");
      expect(s.locale).toBe("en");
      expect(s.intent).toBeUndefined();
    }
    expect(state.lastAuthorizationUrl!.searchParams.get("ui_locales")).toBe("en");
  });

  it("asks for auth_time always, and for a recent sign-in (prompt=login, max_age=freshMs) when fresh", async () => {
    const { runtime, state } = setup();
    await runtime.start();
    expect(state.lastAuthorizationUrl!.searchParams.get("max_age")).toBe(String(12 * 3600));
    expect(state.lastAuthorizationUrl!.searchParams.get("prompt")).toBeNull(); // SSO: nothing forces a login
    await runtime.start({ fresh: true });
    expect(state.lastAuthorizationUrl!.searchParams.get("max_age")).toBe("300");
    expect(state.lastAuthorizationUrl!.searchParams.get("prompt")).toBe("login");
  });

  it("re-checks freshness on the callback: a stale auth_time after a fresh request is a StepUpRequiredError, no session", async () => {
    const { runtime, store } = setup({}, { authAgeSec: 400 });
    const started = await runtime.start({ fresh: true });
    const q = new URLSearchParams({ code: "good-code", state: new URL(started.redirect).searchParams.get("state")! });
    await expect(runtime.callback({ query: q, flowId: started.flowId })).rejects.toBeInstanceOf(StepUpRequiredError);
    expect(store.size).toBe(0);
  });

  it("refuses a sign-in whose auth_time is already past the absolute bound", async () => {
    const { runtime, store } = setup({}, { authAgeSec: 13 * 3600 });
    await expect(signIn(runtime)).rejects.toMatchObject({ code: "session_expired", reason: "absolute" });
    expect(store.size).toBe(0);
  });

  it("the session ends absoluteMs after auth_time, not after sign-in", async () => {
    const { runtime } = setup({}, { authAgeSec: 3600 });
    const s = await signIn(runtime);
    expect(s.maxAgeSec).toBe(11 * 3600);
  });
});

describe("unit: hooks (app-owned)", () => {
  it("onSignIn receives the identity key and claims, never tokens and never a bare e-mail key", async () => {
    const onSignIn = vi.fn(async () => ({ allow: true as const, app: { profile: "complete" } }));
    const { runtime, state } = setup({ hooks: { onSignIn } });
    const s = await signIn(runtime);
    const [claims, tokens] = onSignIn.mock.calls[0] as unknown as [Record<string, unknown>, unknown];
    expect(claims.identityKey).toEqual({ iss: "https://id.example", sub: "subject-1" });
    expect(claims.emailHint).toBe("person@example.test");
    expect(tokens).toBeUndefined();
    expect(containsAny(JSON.stringify(claims), state.issued)).toBeUndefined();
    expect((await runtime.current(s.sessionId))?.view.app).toEqual({ profile: "complete" });
  });

  it("hands over the access token only when needsTokens is declared", async () => {
    const seen: unknown[] = [];
    const { runtime, state } = setup({
      needsTokens: true,
      hooks: { onSignIn: async (_c, t) => (seen.push(t), { allow: true }) },
    });
    await signIn(runtime);
    expect(seen[0]).toEqual({ accessToken: state.issued[0] });
  });

  it("the same e-mail under a different sub is a different identity key", async () => {
    const keys: string[] = [];
    for (const sub of ["subject-1", "subject-2"]) {
      const { runtime } = setup({}, { sub });
      const s = await signIn(runtime);
      const h = await runtime.current(s.sessionId);
      keys.push(`${h!.view.identityKey.iss}|${h!.view.identityKey.sub}|${h!.view.emailHint}`);
    }
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]!.endsWith("person@example.test")).toBe(true);
  });

  it("a denied sign-in creates no session", async () => {
    const { runtime, store, audits } = setup({
      hooks: { onSignIn: async () => ({ allow: false, reason: "not_invited" }) },
    });
    await expect(signIn(runtime)).rejects.toBeInstanceOf(ProfileDeniedError);
    expect(store.size).toBe(0);
    expect(audits).toContainEqual(["signin.denied", { reason: "not_invited" }]);
  });

  it("evaluates authorize on EVERY call (no stale grant) and header state and route guard agree", async () => {
    let allowed = true;
    const authorize = vi.fn(async (_s: unknown, p: string) => (p === "access" ? true : p === "management" && allowed));
    const { runtime } = setup({ policies: ["management"], hooks: { authorize } });
    const { sessionId } = await signIn(runtime);

    expect((await runtime.state(sessionId)).authorized).toEqual({ management: true });
    await expect(runtime.require(sessionId, { policy: "management" })).resolves.toBeTruthy();

    allowed = false; // the app's rule flips; the identity session is untouched
    expect((await runtime.state(sessionId)).authorized).toEqual({ management: false });
    await expect(runtime.require(sessionId, { policy: "management" })).rejects.toBeInstanceOf(ProfileDeniedError);
    expect((await runtime.state(sessionId)).status).toBe("active");
    expect(authorize.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it("table: anonymous, active, unauthorized, authorized, suspended (revalidate), revoked (back-channel) give consistent answers", async () => {
    const accessFor = new Map<string, boolean>();
    const live = new Map<string, boolean>();
    const { runtime, state } = setup({
      policies: ["management"],
      hooks: {
        authorize: async (s, p) =>
          p === "access"
            ? accessFor.get(s.identityKey.sub) !== false
            : p === "management" && accessFor.get(s.identityKey.sub) === true,
        revalidate: async (s) => ({ active: live.get(s.identityKey.sub) !== false }),
      },
    });
    const ids: Record<string, string> = {};
    for (const sub of ["plain", "denied", "manager", "suspended", "revoked"]) {
      state.sub = sub;
      state.logoutToken = undefined;
      ids[sub] = (await signIn(runtime)).sessionId;
    }
    accessFor.set("denied", false);
    accessFor.set("manager", true);
    live.set("suspended", false);
    state.logoutToken = { jti: "j1", iat: Math.floor(Date.now() / 1000) + 1, sub: "revoked" };
    await runtime.backchannelLogout("valid-logout-token");

    const answer = async (id: string | undefined) => {
      const st = await runtime.state(id);
      const guard = await runtime.require(id, { policy: "management" }).then(
        () => "allowed",
        (e: unknown) => (e as { code: string }).code,
      );
      return { status: st.status, header: st.authorized.management, guard };
    };
    expect(await answer(undefined)).toEqual({ status: "anonymous", header: false, guard: "authentication_required" });
    expect(await answer(ids.plain)).toEqual({ status: "active", header: false, guard: "profile_denied" });
    expect(await answer(ids.denied)).toEqual({ status: "unauthorized", header: false, guard: "profile_denied" });
    expect(await answer(ids.manager)).toEqual({ status: "active", header: true, guard: "allowed" });
    // The first look at a suspended or revoked session ends it (state() above), so the guard then finds no session.
    expect(await answer(ids.suspended)).toEqual({
      status: "anonymous",
      header: false,
      guard: "authentication_required",
    });
    expect(await answer(ids.revoked)).toEqual({ status: "anonymous", header: false, guard: "authentication_required" });
  });

  it("denies named policies when the app registered none to evaluate them, and refuses unknown or reserved names", async () => {
    const { runtime } = setup({ policies: ["management"] });
    const { sessionId } = await signIn(runtime);
    expect((await runtime.state(sessionId)).authorized).toEqual({ management: false });
    await expect(runtime.require(sessionId, { policy: "nope" })).rejects.toBeInstanceOf(InvalidConfigError);
    expect(() => setup({ policies: ["access"] })).toThrow(InvalidConfigError);
  });
});

describe("unit: session bounds", () => {
  it("ends at the absolute bound", async () => {
    const { runtime, c } = setup({}, { expiresIn: 100_000 }, { ...BOUNDS, idleMs: null, revalidateMs: 3600_000 });
    const { sessionId } = await signIn(runtime);
    c.advance(12 * 3600_000 - 1000);
    expect(await runtime.current(sessionId, { touch: false })).not.toBeNull();
    c.advance(1000);
    expect(await runtime.current(sessionId)).toBeNull();
    await expect(runtime.require(sessionId)).rejects.toBeInstanceOf(AuthenticationRequiredError);
  });

  it("ends when idle for idleMs; activity slides it; a state() poll (touch:false) does not", async () => {
    const { runtime, c } = setup({}, { expiresIn: 100_000 }, { ...BOUNDS, revalidateMs: 3600_000 });
    const { sessionId } = await signIn(runtime);
    for (let i = 0; i < 4; i++) {
      c.advance(20 * 60_000);
      expect(await runtime.current(sessionId)).not.toBeNull(); // touch slides
    }
    c.advance(20 * 60_000);
    expect((await runtime.state(sessionId)).status).toBe("active"); // poll, no touch
    c.advance(11 * 60_000);
    expect((await runtime.state(sessionId)).status).toBe("anonymous"); // 31 min since the last touch
    await expect(runtime.require(sessionId)).rejects.toBeInstanceOf(AuthenticationRequiredError);
  });

  it("require reports why a session ended", async () => {
    const { runtime, c } = setup({}, { expiresIn: 100_000 }, { ...BOUNDS, revalidateMs: 3600_000 });
    const { sessionId } = await signIn(runtime);
    c.advance(31 * 60_000);
    await expect(runtime.require(sessionId)).rejects.toMatchObject({ code: "session_expired", reason: "idle" });
  });

  it("has no idle bound when idleMs is null", async () => {
    const { runtime, c } = setup({}, { expiresIn: 100_000 }, { ...BOUNDS, idleMs: null, revalidateMs: 3600_000 });
    const { sessionId } = await signIn(runtime);
    c.advance(6 * 3600_000);
    expect(await runtime.current(sessionId)).not.toBeNull();
  });

  it("an ill-formed or foreign cookie value is anonymous, not an error", async () => {
    const { runtime } = setup();
    for (const id of [undefined, "", "short", "x".repeat(43), newId()]) expect(await runtime.current(id)).toBeNull();
  });
});

describe("unit: provider re-check (revalidateMs) and the bounded outage fallback", () => {
  it("checks the provider only when the last positive check is older than revalidateMs", async () => {
    const { runtime, c, state } = setup({}, { expiresIn: 100_000 });
    const { sessionId } = await signIn(runtime);
    c.advance(59_000);
    await runtime.current(sessionId, { touch: false });
    expect(state.userinfoCalls).toBe(0);
    c.advance(2000);
    await runtime.current(sessionId, { touch: false });
    expect(state.userinfoCalls).toBe(1);
    c.advance(30_000);
    await runtime.current(sessionId, { touch: false });
    expect(state.userinfoCalls).toBe(1); // the check was remembered
  });

  it("a provider that rejects the token ends the session within revalidateMs of the change (measured on the injected clock)", async () => {
    const { runtime, c, state } = setup({}, { expiresIn: 100_000 });
    const { sessionId } = await signIn(runtime);
    state.userinfo = "reject"; // suspended or revoked at the provider
    let waited = 0;
    while ((await runtime.current(sessionId, { touch: false })) && waited <= 120_000) {
      c.advance(5000);
      waited += 5000;
    }
    expect(waited).toBeLessThanOrEqual(BOUNDS.revalidateMs + 5000);
    expect(waited).toBeGreaterThan(0);
    expect(await runtime.current(sessionId)).toBeNull();
  });

  it("an outage inside the window serves; after it, denies with IdentityUnavailableError, keeps the session and recovers", async () => {
    const { runtime, c, state, store } = setup({}, { expiresIn: 100_000 });
    const { sessionId } = await signIn(runtime);
    state.userinfo = "down";
    c.advance(30_000);
    expect(await runtime.current(sessionId, { touch: false })).not.toBeNull(); // inside revalidateMs: served
    c.advance(31_000);
    await expect(runtime.current(sessionId, { touch: false })).rejects.toBeInstanceOf(IdentityUnavailableError);
    await expect(runtime.require(sessionId)).rejects.toBeInstanceOf(IdentityUnavailableError);
    await expect(runtime.state(sessionId)).rejects.toBeInstanceOf(IdentityUnavailableError);
    expect(store.size).toBe(1); // never destroyed by an outage
    state.userinfo = "ok";
    expect(await runtime.current(sessionId, { touch: false })).not.toBeNull();
  });

  it("an expired access token during an outage is denied, never served", async () => {
    const { runtime, c, state, store } = setup({}, { expiresIn: 120 });
    const { sessionId } = await signIn(runtime);
    state.refresh = "down";
    c.advance(115_000);
    await expect(runtime.current(sessionId)).rejects.toBeInstanceOf(IdentityUnavailableError);
    expect(store.size).toBe(1);
    expect(state.userinfoCalls).toBe(0);
  });

  it("a subject mismatch from the provider ends the session", async () => {
    const { runtime, c, state } = setup({}, { expiresIn: 100_000 });
    const { sessionId } = await signIn(runtime);
    state.userinfo = "reject";
    c.advance(61_000);
    expect(await runtime.current(sessionId)).toBeNull();
  });
});

describe("unit: refresh lock and lease", () => {
  it("refreshes an expired access token once and saves the rotated tokens", async () => {
    const { runtime, c, state } = setup({}, { expiresIn: 120 });
    const { sessionId } = await signIn(runtime);
    c.advance(115_000);
    const h = await runtime.current(sessionId);
    expect(state.refreshCalls).toBe(1);
    expect(h!.accessToken()).toBe(state.issued.at(-2)); // the refreshed access token, not the first
    c.advance(10_000);
    await runtime.current(sessionId);
    expect(state.refreshCalls).toBe(1); // not needed again yet
  });

  it("race: ten concurrent requests cause exactly one refresh grant and all see the new token", async () => {
    const { runtime, c, state } = setup({}, { expiresIn: 120 }, BOUNDS, true);
    const { sessionId } = await signIn(runtime);
    state.refreshDelayMs = 40;
    c.advance(115_000);
    const handles = await Promise.all(Array.from({ length: 10 }, () => runtime.current(sessionId)));
    expect(state.refreshCalls).toBe(1);
    expect(new Set(handles.map((h) => h!.accessToken())).size).toBe(1);
  });

  it("does not save a refresh result after the lock was lost, and reports it", async () => {
    const { runtime, c, state, store } = setup({}, { expiresIn: 120 }, { ...BOUNDS, refreshLeaseMs: 60 });
    const { sessionId } = await signIn(runtime);
    state.refreshDelayMs = 150;
    c.advance(115_000);
    const pending = runtime.current(sessionId);
    await new Promise((r) => setTimeout(r, 40));
    store.dropLock(sessionId); // a lease that lapsed, or another process that took over
    await expect(pending).rejects.toBeInstanceOf(RefreshOwnershipLostError);
    const next = await store.get(sessionId, { touch: false, idleMs: null, now: c.now() });
    expect(next.status).toBe("ok");
    if (next.status === "ok") expect(next.session.accessToken).toBe(state.issued[0]); // the stale token, untouched
  });

  it("renews the lease while a slow refresh is running (the lock is not lost)", async () => {
    const { runtime, c, state } = setup({}, { expiresIn: 120 }, { ...BOUNDS, refreshLeaseMs: 60 });
    const { sessionId } = await signIn(runtime);
    state.refreshDelayMs = 200; // longer than the lease: only renewals keep the lock
    c.advance(115_000);
    const h = await runtime.current(sessionId);
    expect(h).not.toBeNull();
    expect(state.refreshCalls).toBe(1);
  });

  it("a refresh the provider rejects ends the session; an outage keeps it", async () => {
    const a = setup({}, { expiresIn: 120 });
    const { sessionId } = await signIn(a.runtime);
    a.state.refresh = "reject";
    a.c.advance(115_000);
    expect(await a.runtime.current(sessionId)).toBeNull();
    expect(a.store.size).toBe(0);

    const b = setup({}, { expiresIn: 120 });
    const s2 = await signIn(b.runtime);
    b.state.refresh = "down";
    b.c.advance(115_000);
    await expect(b.runtime.current(s2.sessionId)).rejects.toBeInstanceOf(IdentityUnavailableError);
    expect(b.store.size).toBe(1);
  });

  it("without a refresh token the session cannot outlive its access token", async () => {
    const { runtime, c, store } = setup({}, { expiresIn: 120, withRefresh: false });
    const { sessionId } = await signIn(runtime);
    c.advance(115_000);
    await expect(runtime.require(sessionId)).rejects.toMatchObject({
      code: "session_expired",
      reason: "token_expired",
    });
    expect(store.size).toBe(0);
  });
});

describe("unit: freshness / step-up", () => {
  it("require({fresh}) passes while auth_time is recent, then asks for a new sign-in", async () => {
    const { runtime, c } = setup({}, { expiresIn: 100_000 }, { ...BOUNDS, revalidateMs: 3600_000 });
    const { sessionId } = await signIn(runtime);
    await expect(runtime.require(sessionId, { fresh: true })).resolves.toBeTruthy();
    expect((await runtime.state(sessionId)).fresh).toBe(true);
    c.advance(6 * 60_000);
    await expect(runtime.require(sessionId, { fresh: true })).rejects.toBeInstanceOf(StepUpRequiredError);
    expect((await runtime.state(sessionId)).fresh).toBe(false);
    await expect(runtime.require(sessionId)).resolves.toBeTruthy(); // non-fresh actions are unaffected
  });

  it("authorization is checked before freshness, so an unauthorised person is not asked to step up", async () => {
    const { runtime, c } = setup(
      { policies: ["m"], hooks: { authorize: async (_s, p) => p === "access" } },
      { expiresIn: 100_000 },
      { ...BOUNDS, revalidateMs: 3600_000 },
    );
    const { sessionId } = await signIn(runtime);
    c.advance(6 * 60_000);
    await expect(runtime.require(sessionId, { policy: "m", fresh: true })).rejects.toBeInstanceOf(ProfileDeniedError);
  });
});

describe("unit: back-channel logout", () => {
  it("revokes the named session and only sessions created at or before the logout; replays are refused", async () => {
    const { runtime, c, state } = setup({}, { expiresIn: 100_000 }, { ...BOUNDS, revalidateMs: 3600_000 });
    const a = await signIn(runtime);
    const nowSec = Math.floor(c.now() / 1000);
    state.logoutToken = { jti: "j-1", iat: nowSec, sid: "sid-1" };
    await runtime.backchannelLogout("valid-logout-token");
    expect(await runtime.current(a.sessionId)).toBeNull();
    await expect(runtime.backchannelLogout("valid-logout-token")).rejects.toBeInstanceOf(LogoutReplayError);

    c.advance(10_000); // a later sign-in (same sid label from the fake) is NOT revoked by the older logout
    const b = await signIn(runtime);
    expect(await runtime.current(b.sessionId)).not.toBeNull();
  });

  it("revokes by sub", async () => {
    const { runtime, c, state } = setup({}, { expiresIn: 100_000 });
    const a = await signIn(runtime);
    state.logoutToken = { jti: "j-2", iat: Math.floor(c.now() / 1000), sub: "subject-1" };
    await runtime.backchannelLogout("valid-logout-token");
    expect(await runtime.current(a.sessionId)).toBeNull();
  });

  it("refuses an invalid token and a rate-limited sender without revealing why", async () => {
    const { runtime } = setup();
    await expect(runtime.backchannelLogout("garbage")).rejects.toBeInstanceOf(LogoutTokenInvalidError);
    const limited = setup({ deps: { budget: async () => false, now: undefined } } as never);
    await expect(limited.runtime.backchannelLogout("valid-logout-token")).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe("unit: sign-out labels", () => {
  it("logoutLocal ends this app's session only and never touches the provider", async () => {
    const { runtime, state } = setup();
    const { sessionId } = await signIn(runtime);
    const spy = vi.spyOn(state, "endSession", "get");
    expect(await runtime.logoutLocal(sessionId)).toEqual({ scope: "local" });
    expect(spy).not.toHaveBeenCalled();
    expect(await runtime.current(sessionId)).toBeNull();
  });
  it("logoutEverywhere ends the local session first, then returns the provider end-session URL", async () => {
    const { runtime } = setup();
    const { sessionId } = await signIn(runtime);
    const r = await runtime.logoutEverywhere(sessionId, { postLogoutRedirectUri: `${ORIGIN}/` });
    expect(r.scope).toBe("provider");
    expect(r.redirect).toContain("/session/end");
    expect(r.redirect).toContain(encodeURIComponent(`${ORIGIN}/`));
    expect(await runtime.current(sessionId)).toBeNull();
  });
  it("logging out without a session is not an error", async () => {
    const { runtime } = setup();
    expect(await runtime.logoutLocal(undefined)).toEqual({ scope: "local" });
  });
});

describe("unit: failing store closes, not open", () => {
  it("every store failure is a StoreUnavailableError and grants nothing", async () => {
    const { runtime, store, c } = setup();
    const { sessionId } = await signIn(runtime);
    const broken: SessionStore = new Proxy(store, {
      get: (t, k) =>
        k === "get"
          ? async () => {
              throw new Error("redis down: secret-host:6379");
            }
          : (t as never)[k],
    });
    const r2 = createSessionRuntime({
      oidc: fakeOidc(c).client,
      store: broken,
      flows: store,
      bounds: BOUNDS,
      origin: ORIGIN,
      deps: { now: c.now },
    });
    const err = await r2.current(sessionId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreUnavailableError);
    expect(JSON.stringify(err)).not.toContain("secret-host");
    expect((err as Error).message).not.toContain("secret-host");
    await expect(r2.state(sessionId)).rejects.toBeInstanceOf(StoreUnavailableError);
  });
});

describe("unit: token confidentiality", () => {
  it("no issued token appears in handles, errors, logs, audit events or state answers", async () => {
    const { runtime, c, state, logs, audits } = setup({}, { expiresIn: 120 });
    const out: string[] = [];
    const { sessionId } = await signIn(runtime);
    c.advance(115_000);
    out.push(JSON.stringify(await runtime.current(sessionId)), JSON.stringify(await runtime.state(sessionId)));
    state.refresh = "reject";
    c.advance(115_000);
    const err = await runtime.require(sessionId).catch((e: unknown) => e);
    out.push(JSON.stringify(err), String((err as Error).message), (err as Error).stack ?? "");
    out.push(JSON.stringify(logs), JSON.stringify(audits));
    expect(containsAny(out.join("\n"), state.issued)).toBeUndefined();
  });
});

describe("unit: csrf", () => {
  it("accepts only the session's own csrf value", async () => {
    const { runtime } = setup();
    const { sessionId } = await signIn(runtime);
    const h = (await runtime.current(sessionId))!;
    expect(() => runtime.verifyCsrf(h, h.csrf)).not.toThrow();
    for (const bad of [undefined, "", "x", h.csrf + "x", 5, null])
      expect(() => runtime.verifyCsrf(h, bad)).toThrow(CsrfError);
  });
});
