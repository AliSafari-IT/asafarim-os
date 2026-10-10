import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { canonicalString } from "@asafarim/registry-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  AccessUnavailableError,
  ForbiddenError,
  RegistrationError,
  SESSION_COOKIE_NAME,
  asafarimAuthConfig,
  backoffDelay,
  createAccess,
  createConfig,
  envNameForConfigKey,
  registerApp,
  startApp,
} from "../src/index.ts";

/** A throwaway credential plus the matching public key, like `platform app install` issues. */
function credential() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = "notes.0123456789ab";
  return {
    secret: `osk1.${keyId}.${privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url")}`,
    publicKey,
  };
}

const silent = { info: () => undefined, warn: () => undefined };
const reply = (status: number, body: object) => new Response(JSON.stringify(body), { status });

/** Verify a request the SDK signed, the way core-api does. */
function verifySigned(
  publicKey: KeyObject,
  method: string,
  path: string,
  headers: ConstructorParameters<typeof Headers>[0],
  body = "",
) {
  const h = new Headers(headers);
  const sig = /^v1=(.+)$/.exec(h.get("x-asafarim-signature") ?? "")![1]!;
  const message = canonicalString(h.get("x-asafarim-timestamp")!, h.get("x-asafarim-nonce")!, method, path, body);
  return verify(null, Buffer.from(message), publicKey, Buffer.from(sig, "base64url"));
}

describe("registerApp", () => {
  it("POSTs the manifest, signed over method, path and body; reports the state", async () => {
    const c = credential();
    const manifest = { id: "notes", version: "0.1.0" };
    const fetchMock = vi.fn(async () => reply(200, { state: "active", version: "0.1.0" }));
    const r = await registerApp({
      appId: "notes",
      credential: c.secret,
      coreApiUrl: "http://core/",
      manifest,
      fetch: fetchMock,
      log: silent,
    });
    expect(r).toEqual({ ok: true, attempts: 1, state: "active", version: "0.1.0" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://core/registry/v1/apps/notes");
    expect(init.method).toBe("POST");
    expect(verifySigned(c.publicKey, "POST", "/registry/v1/apps/notes", init.headers!, String(init.body))).toBe(true);
    expect(JSON.parse(String(init.body))).toEqual(manifest);
  });

  it("retries network errors and 5xx with growing backoff and a fresh signature each time", async () => {
    const c = credential();
    const sleeps: number[] = [];
    const nonces: string[] = [];
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(reply(503, { error: "internal" }))
      .mockImplementationOnce(async (_u: string, init: RequestInit) => {
        nonces.push(new Headers(init.headers).get("x-asafarim-nonce")!);
        return reply(200, { state: "installed", version: "1" });
      });
    const r = await registerApp({
      appId: "notes",
      credential: c.secret,
      coreApiUrl: "http://core",
      manifest: {},
      fetch: fetchMock,
      log: silent,
      baseDelayMs: 100,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(r).toMatchObject({ ok: true, attempts: 3 });
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!); // 100·1.x then 200·1.x
    expect(sleeps[0]!).toBeGreaterThanOrEqual(100);
    const seen = fetchMock.mock.calls.map((call) =>
      new Headers((call[1] as RequestInit | undefined)?.headers).get("x-asafarim-nonce"),
    );
    expect(new Set(seen.filter(Boolean)).size).toBe(seen.filter(Boolean).length); // never a replayed nonce
  });

  it("stops at once on a 4xx refusal (permanent), and is non-fatal by default", async () => {
    const c = credential();
    const fetchMock = vi.fn(async () => reply(401, { error: "bad_signature" }));
    const r = await registerApp({
      appId: "notes",
      credential: c.secret,
      coreApiUrl: "http://core",
      manifest: {},
      fetch: fetchMock,
      log: silent,
      sleep: async () => undefined,
    });
    expect(r).toEqual({ ok: false, attempts: 1, error: "bad_signature" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts when core-api stays unreachable; strict mode throws", async () => {
    const c = credential();
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const base = {
      appId: "notes",
      credential: c.secret,
      coreApiUrl: "http://core",
      manifest: {},
      fetch: fetchMock,
      log: silent,
      sleep: async () => undefined,
      maxAttempts: 3,
    };
    expect(await registerApp(base)).toEqual({ ok: false, attempts: 3, error: "unreachable" });
    await expect(registerApp({ ...base, strict: true })).rejects.toBeInstanceOf(RegistrationError);
  });

  it("encodes the app id in the registration path it signs and sends", async () => {
    const c = credential();
    const fetchMock = vi.fn(async () => reply(200, { state: "active", version: "1" }));
    await registerApp({
      appId: "a/b",
      credential: c.secret,
      coreApiUrl: "http://core",
      manifest: {},
      fetch: fetchMock,
      log: silent,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://core/registry/v1/apps/a%2Fb");
    expect(verifySigned(c.publicKey, "POST", "/registry/v1/apps/a%2Fb", init.headers!, String(init.body))).toBe(true);
  });

  it("backoffDelay doubles up to the cap, with at most 25% jitter", () => {
    const none = () => 0;
    expect([1, 2, 3, 4, 5].map((n) => backoffDelay(n, 500, 4000, none))).toEqual([500, 1000, 2000, 4000, 4000]);
    expect(backoffDelay(1, 500, 4000, () => 1)).toBe(625);
  });
});

describe("registerApp: the event-schema upload (P4.2)", () => {
  const manifest = {
    id: "notes",
    version: "0.1.0",
    events: { publishes: [{ type: "notes.note.created.v1", schema: "./events/notes.note.created.v1.json" }] },
  };
  const schema = { type: "object", title: "created" };
  const schemas = { "./events/notes.note.created.v1.json": schema };

  it("after a successful registration, PUTs { schemas: { <type>: <schema> } }, signed over PUT and its path", async () => {
    const c = credential();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(200, { state: "active", version: "0.1.0" }))
      .mockResolvedValueOnce(reply(200, { appId: "notes", version: "0.1.0", types: ["notes.note.created.v1"] }));
    const r = await registerApp({
      appId: "notes",
      credential: c.secret,
      coreApiUrl: "http://core",
      manifest,
      schemas,
      fetch: fetchMock,
      log: silent,
    });
    expect(r).toEqual({
      ok: true,
      attempts: 1,
      state: "active",
      version: "0.1.0",
      schemas: { ok: true, attempts: 1, types: ["notes.note.created.v1"] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("http://core/registry/v1/apps/notes/event-schemas");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ schemas: { "notes.note.created.v1": schema } });
    expect(
      verifySigned(c.publicKey, "PUT", "/registry/v1/apps/notes/event-schemas", init.headers!, String(init.body)),
    ).toBe(true);
  });

  it("retries the upload on network errors and 5xx, with backoff", async () => {
    const c = credential();
    const sleeps: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(200, { state: "active", version: "0.1.0" }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(reply(503, { error: "internal" }))
      .mockResolvedValueOnce(reply(200, { types: ["notes.note.created.v1"] }));
    const r = await registerApp({
      appId: "notes",
      credential: c.secret,
      coreApiUrl: "http://core",
      manifest,
      schemas,
      fetch: fetchMock,
      log: silent,
      baseDelayMs: 100,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(r.schemas).toEqual({ ok: true, attempts: 3, types: ["notes.note.created.v1"] });
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
  });

  it("a failed upload is logged and never throws, even with strict; a 4xx isn't retried", async () => {
    const c = credential();
    const warn = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(200, { state: "active", version: "0.1.0" }))
      .mockResolvedValueOnce(reply(400, { error: "invalid_event_schemas" }));
    const r = await registerApp({
      appId: "notes",
      credential: c.secret,
      coreApiUrl: "http://core",
      manifest,
      schemas,
      strict: true,
      fetch: fetchMock,
      log: { info: () => undefined, warn },
      sleep: async () => undefined,
    });
    expect(r).toMatchObject({ ok: true, schemas: { ok: false, attempts: 1, error: "invalid_event_schemas" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "app.event_schemas_failed",
      expect.objectContaining({ error: "invalid_event_schemas" }),
    );

    const down = vi
      .fn()
      .mockResolvedValueOnce(reply(200, { state: "active", version: "0.1.0" }))
      .mockRejectedValue(new TypeError("fetch failed"));
    const r2 = await registerApp({
      appId: "notes",
      credential: c.secret,
      coreApiUrl: "http://core",
      manifest,
      schemas,
      strict: true,
      maxAttempts: 3,
      fetch: down,
      log: silent,
      sleep: async () => undefined,
    });
    expect(r2.schemas).toEqual({ ok: false, attempts: 3, error: "unreachable" });
  });

  it("nothing is uploaded when registration fails, without schemas, or when the app publishes nothing", async () => {
    const c = credential();
    const base = { appId: "notes", credential: c.secret, coreApiUrl: "http://core", log: silent };
    const refused = vi.fn(async () => reply(401, { error: "bad_signature" }));
    expect(await registerApp({ ...base, manifest, schemas, fetch: refused })).toEqual({
      ok: false,
      attempts: 1,
      error: "bad_signature",
    });
    expect(refused).toHaveBeenCalledTimes(1);

    const ok = vi.fn(async () => reply(200, { state: "active", version: "0.1.0" }));
    expect((await registerApp({ ...base, manifest, fetch: ok })).schemas).toBeUndefined();
    expect((await registerApp({ ...base, manifest: { id: "notes" }, schemas, fetch: ok })).schemas).toBeUndefined();
    expect(ok).toHaveBeenCalledTimes(2); // registrations only
  });

  it("a published type with no schema given isn't uploaded (missing_schema), and registration still succeeds", async () => {
    const c = credential();
    const fetchMock = vi.fn(async () => reply(200, { state: "active", version: "0.1.0" }));
    const r = await registerApp({
      appId: "notes",
      credential: c.secret,
      coreApiUrl: "http://core",
      manifest,
      schemas: { "./events/other.json": schema },
      fetch: fetchMock,
      log: silent,
    });
    expect(r).toMatchObject({ ok: true, schemas: { ok: false, attempts: 0, error: "missing_schema" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("createAccess (permission checks resolved from core-api)", () => {
  const body = {
    appId: "notes",
    subject: "dev-member",
    state: "active",
    roles: ["notes.viewer"],
    permissions: ["notes.read"],
  };

  it("asks core-api with a signed GET bound to the subject path, and answers can()", async () => {
    const c = credential();
    const fetchMock = vi.fn(async () => reply(200, body));
    const access = createAccess({ appId: "notes", credential: c.secret, coreApiUrl: "http://core", fetch: fetchMock });
    const session = { user: { id: "dev-member" } };
    expect(await access.can(session, "notes.read")).toBe(true);
    expect(await access.can(session, "notes.write")).toBe(false);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://core/registry/v1/apps/notes/subjects/dev-member");
    expect(verifySigned(c.publicKey, "GET", "/registry/v1/apps/notes/subjects/dev-member", init.headers!)).toBe(true);
  });

  it("caches for the TTL (one request for many checks), then asks again", async () => {
    const c = credential();
    let t = 0;
    const fetchMock = vi.fn(async () => reply(200, body));
    const access = createAccess({
      appId: "notes",
      credential: c.secret,
      coreApiUrl: "http://core",
      fetch: fetchMock,
      ttlMs: 60_000,
      now: () => t,
    });
    const s = { user: { id: "dev-member" } };
    await Promise.all([access.can(s, "notes.read"), access.can(s, "notes.write"), access.can(s, "notes.read")]);
    t = 59_000;
    await access.can(s, "notes.read");
    expect(fetchMock).toHaveBeenCalledTimes(1); // concurrent lookups shared one request; still fresh at 59 s
    t = 61_000;
    await access.can(s, "notes.read");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("require() throws ForbiddenError naming the permission, and passes with it", async () => {
    const c = credential();
    const access = createAccess({
      appId: "notes",
      credential: c.secret,
      coreApiUrl: "http://core",
      fetch: async () => reply(200, body),
    });
    const s = { user: { id: "dev-member" } };
    await expect(access.require(s, "notes.write")).rejects.toMatchObject({
      name: "ForbiddenError",
      permission: "notes.write",
      status: 403,
    });
    await expect(access.require(s, "notes.write")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(access.require(s, "notes.read")).resolves.toMatchObject({ state: "active" });
    await expect(access.require(null, "notes.read")).rejects.toBeInstanceOf(ForbiddenError); // no session
  });

  it("fails closed: with core-api down there's no stale answer; can() is false, access() throws", async () => {
    const c = credential();
    let t = 0;
    let up = true;
    const fetchMock = vi.fn(async () => {
      if (!up) throw new TypeError("fetch failed");
      return reply(200, body);
    });
    const access = createAccess({
      appId: "notes",
      credential: c.secret,
      coreApiUrl: "http://core",
      fetch: fetchMock,
      ttlMs: 1000,
      now: () => t,
    });
    const s = { user: { id: "dev-member" } };
    expect(await access.can(s, "notes.read")).toBe(true);
    up = false;
    t = 5000; // the cached answer has expired
    expect(await access.can(s, "notes.read")).toBe(false);
    await expect(access.access("dev-member")).rejects.toBeInstanceOf(AccessUnavailableError);
    await expect(access.require(s, "notes.read")).rejects.toBeInstanceOf(AccessUnavailableError);
  });

  it("a 200 that isn't the contract is unavailable, never cached as an empty grant", async () => {
    const c = credential();
    for (const bad of [
      {},
      { state: "active" },
      { state: 7, roles: [], permissions: [] },
      { state: "active", roles: "x", permissions: [] },
    ]) {
      const fetchMock = vi.fn(async () => reply(200, bad));
      const access = createAccess({
        appId: "notes",
        credential: c.secret,
        coreApiUrl: "http://core",
        fetch: fetchMock,
      });
      await expect(access.access("dev-member")).rejects.toThrow(/malformed/);
      await expect(access.access("dev-member")).rejects.toThrow(/malformed/); // not cached: asked again
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it("encodes the app id and the subject in the path it signs and sends", async () => {
    const c = credential();
    const fetchMock = vi.fn(async () => reply(200, { ...body, subject: "a@b" }));
    const access = createAccess({ appId: "a b", credential: c.secret, coreApiUrl: "http://core", fetch: fetchMock });
    await access.access("a@b");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://core/registry/v1/apps/a%20b/subjects/a%40b");
    expect(verifySigned(c.publicKey, "GET", "/registry/v1/apps/a%20b/subjects/a%40b", init.headers!)).toBe(true);
  });

  it("a refusal from core-api (e.g. a revoked credential) is also unavailable, not an empty grant", async () => {
    const c = credential();
    const access = createAccess({
      appId: "notes",
      credential: c.secret,
      coreApiUrl: "http://core",
      fetch: async () => reply(401, { error: "bad_signature" }),
    });
    await expect(access.access("x")).rejects.toThrow(/bad_signature/);
  });
});

describe("createConfig (typed, from the manifest)", () => {
  const manifest = {
    config: [
      { key: "limits.maxNotes", type: "int" as const, default: 100 },
      { key: "title", type: "string" as const, default: "Notes" },
      { key: "betaBanner", type: "boolean" as const, default: false },
      { key: "ratio", type: "number" as const, default: 0.5 },
    ],
  };

  it("maps keys to APP_CONFIG_* env names", () => {
    expect(envNameForConfigKey("limits.maxNotes")).toBe("APP_CONFIG_LIMITS_MAX_NOTES");
    expect(envNameForConfigKey("betaBanner")).toBe("APP_CONFIG_BETA_BANNER");
  });

  it("returns defaults, env overrides with the declared type, and every value", () => {
    expect(createConfig(manifest, {}).getInt("limits.maxNotes")).toBe(100);
    const c = createConfig(manifest, {
      APP_CONFIG_LIMITS_MAX_NOTES: "5",
      APP_CONFIG_BETA_BANNER: "true",
      APP_CONFIG_RATIO: "0.25",
      APP_CONFIG_TITLE: "Mine",
    });
    expect([
      c.getInt("limits.maxNotes"),
      c.getBoolean("betaBanner"),
      c.getNumber("ratio"),
      c.getString("title"),
    ]).toEqual([5, true, 0.25, "Mine"]);
    expect(c.all()).toEqual({ "limits.maxNotes": 5, title: "Mine", betaBanner: true, ratio: 0.25 });
  });

  it("refuses an undeclared key, the wrong type, and a malformed value (at startup)", () => {
    const c = createConfig(manifest, {});
    expect(() => c.getInt("limits.maxNote")).toThrow(/isn't declared/);
    expect(() => c.getString("limits.maxNotes")).toThrow(/is a int, not string/);
    expect(() => createConfig(manifest, { APP_CONFIG_LIMITS_MAX_NOTES: "lots" })).toThrow(/must be a int/);
    expect(() => createConfig(manifest, { APP_CONFIG_BETA_BANNER: "maybe" })).toThrow(/must be a boolean/);
  });
});

describe("asafarimAuthConfig (Auth.js)", () => {
  it("is an OIDC code + PKCE public client against the issuer, with a host-only __Host- session cookie", () => {
    const cfg = asafarimAuthConfig({ issuer: "http://localhost:4010/", clientId: "notes", secret: "s" });
    const p = cfg.providers[0]!;
    expect(p).toMatchObject({
      id: "asafarim",
      type: "oidc",
      issuer: "http://localhost:4010",
      clientId: "notes",
      client: { token_endpoint_auth_method: "none" },
    });
    expect(p).not.toHaveProperty("clientSecret");
    expect(p.checks).toEqual(["pkce", "state", "nonce"]);
    expect(p.authorization.params.scope).toBe("openid email profile roles");
    expect(cfg.cookies.sessionToken.name).toBe(SESSION_COOKIE_NAME);
    expect(SESSION_COOKIE_NAME.startsWith("__Host-")).toBe(true);
    expect(cfg.cookies.sessionToken.options).toEqual({ httpOnly: true, sameSite: "lax", path: "/", secure: true });
    expect(cfg.cookies.sessionToken.options).not.toHaveProperty("domain"); // __Host- forbids it
  });

  it("a confidential client authenticates with its secret", () => {
    const p = asafarimAuthConfig({
      issuer: "https://id.asafarim.site",
      clientId: "notes",
      clientSecret: "x".repeat(32),
    }).providers[0]!;
    expect(p).toMatchObject({
      clientSecret: "x".repeat(32),
      client: { token_endpoint_auth_method: "client_secret_basic" },
    });
  });

  it("puts the identity sub on the token and session.user.id", () => {
    const cfg = asafarimAuthConfig({ issuer: "http://localhost:4010", clientId: "notes" });
    const token = cfg.callbacks.jwt({ token: {}, profile: { sub: "dev-member", roles: ["member"] } });
    expect(token).toEqual({ sub: "dev-member", roles: ["member"] });
    expect(cfg.callbacks.session({ session: { user: {} }, token }).user).toEqual({ id: "dev-member" });
  });
});

describe("startApp", () => {
  const manifest = { id: "notes", config: [], version: "0.1.0" } as never;

  it("without credentials logs once and denies everything, never throwing at startup", async () => {
    const warn = vi.fn();
    const p = startApp({ manifest, env: {}, log: { info: () => undefined, warn } });
    expect(await p.registered).toEqual({ ok: false, attempts: 0, error: "not_installed" });
    expect(warn).toHaveBeenCalledWith("app.not_installed", expect.objectContaining({ appId: "notes" }));
    expect(await p.access.can({ user: { id: "x" } }, "notes.read")).toBe(false);
  });

  it("with credentials registers in the background and exposes access", async () => {
    const c = credential();
    const fetchMock = vi.fn(async () => reply(200, { state: "active", version: "0.1.0" }));
    const p = startApp({
      manifest,
      env: { ASAFARIM_REGISTRY_CREDENTIAL: c.secret, CORE_API_URL: "http://core" },
      log: silent,
      fetch: fetchMock,
    });
    expect(await p.registered).toMatchObject({ ok: true, state: "active" });
  });
});

describe("asafarimAuthConfig: the ID token and session lifetime (the Admin console)", () => {
  const jwt = (cfg: ReturnType<typeof asafarimAuthConfig>, args: object) =>
    (cfg.callbacks.jwt as (a: object) => Record<string, unknown>)({ token: {}, ...args });

  it("doesn't keep the ID token by default", () => {
    const cfg = asafarimAuthConfig({ issuer: "http://id", clientId: "notes" });
    expect(jwt(cfg, { profile: { sub: "u1" }, account: { id_token: "a.b.c" } })).toEqual({ sub: "u1" });
    expect(cfg.session).toEqual({ strategy: "jwt" });
  });

  it("keeps it in the token (never the session) when asked, and only at sign-in", () => {
    const cfg = asafarimAuthConfig({
      issuer: "http://id",
      clientId: "core-admin",
      keepIdToken: true,
      sessionMaxAgeSeconds: 3600,
    });
    expect(jwt(cfg, { profile: { sub: "u1" }, account: { id_token: "a.b.c" } })).toEqual({
      sub: "u1",
      idToken: "a.b.c",
    });
    expect(jwt(cfg, {})).toEqual({}); // a later request has no `account`
    const session = (cfg.callbacks.session as (a: object) => { user: Record<string, unknown> })({
      session: { user: {} },
      token: { sub: "u1", idToken: "a.b.c" },
    });
    expect(JSON.stringify(session)).not.toContain("a.b.c");
    expect(cfg.session).toEqual({ strategy: "jwt", maxAge: 3600 });
  });
});
