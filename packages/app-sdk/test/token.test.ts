import { generateKeyPairSync, verify } from "node:crypto";
import {
  ACCESS_COOKIE_NAME,
  ACCESS_SESSION_PATH,
  canonicalString,
  jwksOf,
  signAccessToken,
  verificationKeyOf,
  type SigningKey,
} from "@asafarim/registry-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  AccessUnavailableError,
  accessCookie,
  clearAccessCookie,
  createAccess,
  createSessionHandler,
  createTokenVerifier,
  forwardedOrigin,
  safeNext,
  withForwardedOrigin,
} from "../src/index.ts";

const keyPair = (kid: string) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key: SigningKey = { kid, privateJwk: privateKey.export({ format: "jwk" }) };
  return { key, publicKey };
};
const credential = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = "notes.0123456789ab";
  return {
    secret: `osk1.${keyId}.${privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url")}`,
    publicKey,
  };
};
const NOW = new Date("2026-10-04T12:00:00Z");
const issue = (key: SigningKey, over: { sub?: string; aud?: string; perms?: string[]; roles?: string[] } = {}) =>
  signAccessToken({
    key,
    subject: over.sub ?? "dev-member",
    audience: over.aud ?? "notes",
    roles: over.roles ?? ["notes.viewer"],
    permissions: over.perms ?? ["notes.read"],
    now: NOW,
  }).token;

/** A core-api double: serves a JWKS and counts the fetches. */
function coreApi(keys: SigningKey[]) {
  const calls = { jwks: 0 };
  let current = keys;
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith("/.well-known/jwks.json")) {
      calls.jwks++;
      return new Response(JSON.stringify(jwksOf(current.map(verificationKeyOf))), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls, rotate: (k: SigningKey[]) => (current = k) };
}

describe("the token verifier", () => {
  it("verifies a genuine token for this app, and caches the keys", async () => {
    const { key } = keyPair("k1");
    const api = coreApi([key]);
    const v = createTokenVerifier({ appId: "notes", coreApiUrl: "http://core", fetch: api.fetchFn, now: () => NOW });
    expect(await v.verify(issue(key))).toMatchObject({ sub: "dev-member", aud: "notes", perms: ["notes.read"] });
    expect(await v.verify(issue(key))).toBeDefined();
    expect(api.calls.jwks).toBe(1); // one fetch for both
  });

  it("refuses a token for another app, an expired one, a forged one, none, and garbage", async () => {
    const { key } = keyPair("k1");
    const api = coreApi([key]);
    const v = createTokenVerifier({ appId: "notes", coreApiUrl: "http://core", fetch: api.fetchFn, now: () => NOW });
    expect(await v.verify(issue(key, { aud: "tasks" }))).toBeUndefined();
    const later = createTokenVerifier({
      appId: "notes",
      coreApiUrl: "http://core",
      fetch: api.fetchFn,
      now: () => new Date(NOW.getTime() + 120_000),
    });
    expect(await later.verify(issue(key))).toBeUndefined();
    expect(await v.verify(`${issue(key).slice(0, -4)}AAAA`)).toBeUndefined();
    expect(await v.verify(issue(keyPair("k1").key))).toBeUndefined(); // same kid, another key
    expect(await v.verify(undefined)).toBeUndefined();
    expect(await v.verify("not-a-token")).toBeUndefined();
  });

  it("follows a key rotation with one rate-limited refetch", async () => {
    const a = keyPair("k1").key;
    const b = keyPair("k2").key;
    const api = coreApi([a]);
    let t = NOW.getTime();
    const v = createTokenVerifier({
      appId: "notes",
      coreApiUrl: "http://core",
      fetch: api.fetchFn,
      now: () => new Date(t),
    });
    expect(await v.verify(issue(a))).toBeDefined();
    api.rotate([b]);
    t += 31_000; // past the 30 s cooldown, still inside the keys' own TTL
    // (the token was issued at NOW: re-issue at the new time so it isn't expired)
    const fresh = signAccessToken({
      key: b,
      subject: "dev-member",
      audience: "notes",
      roles: [],
      permissions: ["notes.read"],
      now: new Date(t),
    }).token;
    expect(await v.verify(fresh)).toBeDefined();
    expect(api.calls.jwks).toBe(2);
    // A flood of unknown key ids doesn't become a flood of fetches.
    const stranger = signAccessToken({
      key: keyPair("zz").key,
      subject: "x",
      audience: "notes",
      roles: [],
      permissions: [],
      now: new Date(t),
    }).token;
    for (let i = 0; i < 5; i++) expect(await v.verify(stranger)).toBeUndefined();
    expect(api.calls.jwks).toBeLessThanOrEqual(3);
  });

  it("fails closed when core-api is unreachable: no keys, no valid token", async () => {
    const { key } = keyPair("k1");
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const v = createTokenVerifier({ appId: "notes", coreApiUrl: "http://core", fetch: down, now: () => NOW });
    expect(await v.verify(issue(key))).toBeUndefined();
  });
});

describe("access with a token", () => {
  function access(api: ReturnType<typeof coreApi>, extra: Partial<Parameters<typeof createAccess>[0]> = {}) {
    const cred = credential();
    const lookups: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/subjects/")) {
        lookups.push(`${init?.method ?? "GET"} ${url}`);
        return init?.method === "POST"
          ? new Response(JSON.stringify({ token: "tok", expiresIn: 60 }), { status: 200 })
          : new Response(
              JSON.stringify({ state: "active", roles: ["notes.editor"], permissions: ["notes.read", "notes.write"] }),
              { status: 200 },
            );
      }
      return api.fetchFn(input);
    }) as unknown as typeof fetch;
    return {
      lookups,
      cred,
      access: createAccess({
        appId: "notes",
        credential: cred.secret,
        coreApiUrl: "http://core",
        fetch: fetchFn,
        now: () => NOW.getTime(),
        ...extra,
      }),
    };
  }
  const session = { user: { id: "dev-member" } };

  it("a valid token answers can()/require() with its own permissions: no lookup at all", async () => {
    const { key } = keyPair("k1");
    const { access: a, lookups } = access(coreApi([key]));
    const token = issue(key, { perms: ["notes.read"], roles: ["notes.viewer"] });
    expect(await a.can(session, "notes.read", { token })).toBe(true);
    expect(await a.can(session, "notes.write", { token })).toBe(false);
    await expect(a.require(session, "notes.write", { token })).rejects.toMatchObject({
      name: "ForbiddenError",
      permission: "notes.write",
    });
    expect(await a.access("dev-member", { token })).toEqual({
      subject: "dev-member",
      state: "active",
      roles: ["notes.viewer"],
      permissions: ["notes.read"],
    });
    expect(lookups).toEqual([]);
  });

  it("a token for ANOTHER person is ignored: the answer comes from core-api for this subject", async () => {
    const { key } = keyPair("k1");
    const { access: a, lookups } = access(coreApi([key]));
    const stolen = issue(key, { sub: "someone-else", perms: ["notes.read", "notes.write", "notes.admin"] });
    expect(await a.can(session, "notes.admin", { token: stolen })).toBe(false);
    expect(lookups).toHaveLength(1);
  });

  it("no token, or a bad one, falls back to core-api (cached)", async () => {
    const { key } = keyPair("k1");
    const { access: a, lookups } = access(coreApi([key]));
    expect(await a.can(session, "notes.write")).toBe(true);
    expect(await a.can(session, "notes.write", { token: "garbage" })).toBe(true);
    expect(lookups).toHaveLength(1); // the second answer came from the cache
  });

  it("mintToken: a signed POST bound to the subject's token path", async () => {
    const { key } = keyPair("k1");
    const calls: { url: string; init?: RequestInit }[] = [];
    const cred = credential();
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ token: "tok", expiresIn: 60 }), { status: 200 });
    }) as unknown as typeof fetch;
    const a = createAccess({
      appId: "notes",
      credential: cred.secret,
      coreApiUrl: "http://core/",
      fetch: fetchFn,
      tokens: createTokenVerifier({ appId: "notes", coreApiUrl: "http://core", fetch: coreApi([key]).fetchFn }),
    });
    expect(await a.mintToken("user@example.test")).toEqual({ token: "tok", expiresIn: 60 });
    const path = "/registry/v1/apps/notes/subjects/user%40example.test/token";
    expect(calls[0]!.url).toBe(`http://core${path}`);
    expect(calls[0]!.init?.method).toBe("POST");
    const h = new Headers(calls[0]!.init?.headers);
    const sig = /^v1=(.+)$/.exec(h.get("x-asafarim-signature")!)![1]!;
    const message = canonicalString(h.get("x-asafarim-timestamp")!, h.get("x-asafarim-nonce")!, "POST", path, "");
    expect(verify(null, Buffer.from(message), cred.publicKey, Buffer.from(sig, "base64url"))).toBe(true);
  });

  it("mintToken reports an inactive app or an outage as AccessUnavailableError, never a token", async () => {
    const cred = credential();
    const inactive = vi.fn(
      async () => new Response(JSON.stringify({ error: "app_inactive" }), { status: 503 }),
    ) as unknown as typeof fetch;
    const a = createAccess({ appId: "notes", credential: cred.secret, coreApiUrl: "http://core", fetch: inactive });
    await expect(a.mintToken("x")).rejects.toThrow(AccessUnavailableError);
    const broken = vi.fn(
      async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 }),
    ) as unknown as typeof fetch;
    const b = createAccess({ appId: "notes", credential: cred.secret, coreApiUrl: "http://core", fetch: broken });
    await expect(b.mintToken("x")).rejects.toThrow(/malformed/);
  });
});

describe("safeNext (no open redirects)", () => {
  it("keeps same-site paths with a query", () => {
    expect(safeNext("/")).toBe("/");
    expect(safeNext("/api/notes?page=2&x=a%20b")).toBe("/api/notes?page=2&x=a%20b");
  });
  it("refuses protocol-relative, absolute, backslash, control-character and over-long targets", () => {
    for (const bad of [
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "evil",
      "/a\r\nSet-Cookie: x=1",
      "/" + "a".repeat(3000),
      "",
      null,
      undefined,
    ]) {
      expect(safeNext(bad as string), String(bad)).toBe("/");
    }
  });
  it("won't send the person back to the session endpoint itself", () => {
    expect(safeNext(ACCESS_SESSION_PATH)).toBe("/");
    expect(safeNext(`${ACCESS_SESSION_PATH}?next=/x`)).toBe("/");
  });
});

describe("the cookie", () => {
  it("is host-only (no Domain), HttpOnly, Secure, SameSite=Lax, and as short-lived as the token", () => {
    const c = accessCookie("abc.def.ghi", 60);
    expect(c).toBe(`${ACCESS_COOKIE_NAME}=abc.def.ghi; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax`);
    expect(c).not.toMatch(/Domain=/i);
    expect(ACCESS_COOKIE_NAME.startsWith("__Host-")).toBe(true);
    expect(clearAccessCookie()).toContain("Max-Age=0");
  });
});

describe("the session handler", () => {
  const req = (next?: string) =>
    new Request(
      `http://notes.localhost:8080${ACCESS_SESSION_PATH}${next === undefined ? "" : `?next=${encodeURIComponent(next)}`}`,
    );

  it("signed in: sets the token cookie and goes back to next", async () => {
    const mint = vi.fn(async () => ({ token: "t.o.k", expiresIn: 60 }));
    const GET = createSessionHandler({ subject: async () => "dev-member", mintToken: mint });
    const res = await GET(req("/api/notes?page=2"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/api/notes?page=2");
    expect(res.headers.get("set-cookie")).toBe(accessCookie("t.o.k", 60));
    expect(mint).toHaveBeenCalledWith("dev-member");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("not signed in: to the sign-in page, returning to next afterwards; no token is minted", async () => {
    const mint = vi.fn();
    const GET = createSessionHandler({ subject: async () => undefined, mintToken: mint });
    const res = await GET(req("/api/notes"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/api/auth/signin?callbackUrl=${encodeURIComponent("/api/notes")}`);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(mint).not.toHaveBeenCalled();
  });

  it("an evil next becomes /", async () => {
    const GET = createSessionHandler({
      subject: async () => "dev-member",
      mintToken: async () => ({ token: "t", expiresIn: 60 }),
    });
    expect((await GET(req("//evil.example/x"))).headers.get("location")).toBe("/");
    expect((await GET(req())).headers.get("location")).toBe("/");
  });

  it("can't issue a token: 503, never a redirect back (that would loop through the gateway)", async () => {
    const GET = createSessionHandler({
      subject: async () => "dev-member",
      mintToken: async () => {
        throw new AccessUnavailableError("app_inactive");
      },
    });
    const res = await GET(req("/api/notes"));
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("withForwardedOrigin (Auth.js behind the gateway)", () => {
  const forwarded = (url: string, headers: Record<string, string>, init: RequestInit = {}) =>
    withForwardedOrigin(new Request(url, { headers, ...init }));

  it("puts the forwarded host and protocol into the URL, keeping the path and query", () => {
    const r = forwarded("http://localhost:4100/api/auth/callback/asafarim?code=c&state=s", {
      "x-forwarded-host": "notes.localhost:8080",
      "x-forwarded-proto": "http",
    });
    expect(r.url).toBe("http://notes.localhost:8080/api/auth/callback/asafarim?code=c&state=s");
  });

  it("takes the first of a comma-separated list, and switches to https when told", () => {
    const r = forwarded("http://localhost:4100/x", {
      "x-forwarded-host": "notes.asafarim.site, internal.proxy",
      "x-forwarded-proto": "https, http",
    });
    expect(r.url).toBe("https://notes.asafarim.site/x");
  });

  it("leaves the request alone without a forwarded host, or with one that isn't a host", () => {
    const plain = new Request("http://localhost:4100/x");
    expect(withForwardedOrigin(plain)).toBe(plain);
    for (const bad of ["evil.example/path", "a b", "evil.example@x", "http://x", "x:99999999", "-x", "x?y"]) {
      const r = new Request("http://localhost:4100/x", { headers: { "x-forwarded-host": bad } });
      expect(withForwardedOrigin(r), bad).toBe(r);
    }
  });

  it("carries the method, headers and body of a POST", async () => {
    const r = forwarded(
      "http://localhost:4100/api/auth/signout",
      {
        "x-forwarded-host": "notes.localhost:8080",
        "x-forwarded-proto": "http",
        "content-type": "text/plain",
        cookie: "a=b",
      },
      { method: "POST", body: "csrfToken=abc" },
    );
    expect(r.method).toBe("POST");
    expect(r.url).toBe("http://notes.localhost:8080/api/auth/signout");
    expect(r.headers.get("cookie")).toBe("a=b");
    expect(await r.text()).toBe("csrfToken=abc");
  });

  it("forwardedOrigin hands the wrapped request to the handler", async () => {
    const seen: string[] = [];
    const wrapped = forwardedOrigin(async (req: Request) => (seen.push(req.url), new Response("ok")));
    await wrapped(new Request("http://localhost:4100/x", { headers: { "x-forwarded-host": "notes.localhost:8080" } }));
    expect(seen).toEqual(["http://notes.localhost:8080/x"]);
  });
});
