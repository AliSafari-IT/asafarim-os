import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createAdminAuth, createIdentityVerifier } from "../src/admin-auth.ts";
import { parseAdminToken } from "../src/server.ts";

const ISSUER = "http://identity.test";
const AUDIENCE = "core-admin";
const STATIC = "s".repeat(40);

async function keyPair(alg = "ES256", kid = "k1") {
  const { publicKey, privateKey } = await generateKeyPair(alg);
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
  return { privateKey, keys: createLocalJWKSet({ keys: [jwk] }), kid, alg };
}

async function idToken(
  k: Awaited<ReturnType<typeof keyPair>>,
  over: { sub?: string; iss?: string; aud?: string; exp?: string | number } = {},
) {
  return new SignJWT({ sub: over.sub ?? "dev-admin" })
    .setProtectedHeader({ alg: k.alg, kid: k.kid })
    .setIssuer(over.iss ?? ISSUER)
    .setAudience(over.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(over.exp ?? "1h")
    .sign(k.privateKey);
}

describe("the identity verifier", () => {
  it("accepts a token from the issuer for the console's client and returns its sub", async () => {
    const k = await keyPair();
    const v = createIdentityVerifier({ issuer: ISSUER, audience: AUDIENCE, keys: k.keys });
    expect(await v.verify(await idToken(k))).toBe("dev-admin");
  });

  it("refuses the wrong audience, the wrong issuer, an expired token and another key", async () => {
    const k = await keyPair();
    const v = createIdentityVerifier({ issuer: ISSUER, audience: AUDIENCE, keys: k.keys });
    await expect(v.verify(await idToken(k, { aud: "notes" }))).rejects.toThrow();
    await expect(v.verify(await idToken(k, { iss: "http://evil.test" }))).rejects.toThrow();
    await expect(v.verify(await idToken(k, { exp: Math.floor(Date.now() / 1000) - 600 }))).rejects.toThrow();
    const other = await keyPair("ES256", "k1"); // same kid, different key
    await expect(v.verify(await idToken(other))).rejects.toThrow();
  });

  it("only ES256: another algorithm, and alg none, are refused", async () => {
    const k = await keyPair();
    const v = createIdentityVerifier({ issuer: ISSUER, audience: AUDIENCE, keys: k.keys });
    const rs = await keyPair("RS256", "k1");
    await expect(
      createIdentityVerifier({ issuer: ISSUER, audience: AUDIENCE, keys: rs.keys }).verify(await idToken(rs)),
    ).rejects.toThrow();
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
      JSON.stringify({ sub: "dev-admin", iss: ISSUER, aud: AUDIENCE, exp: 9999999999 }),
    ).toString("base64url")}.`;
    await expect(v.verify(none)).rejects.toThrow();
  });

  it("refuses a sub that isn't a plain subject", async () => {
    const k = await keyPair();
    const v = createIdentityVerifier({ issuer: ISSUER, audience: AUDIENCE, keys: k.keys });
    for (const sub of ["a/b", "x y", "", "x".repeat(200)])
      await expect(v.verify(await idToken(k, { sub })), sub).rejects.toThrow();
  });

  it("discovers the JWKS from the issuer's metadata, and only on the issuer's own origin", async () => {
    const k = await keyPair();
    const jwk = { ...(await exportJWK((await generateKeyPair("ES256")).publicKey)), kid: "z" };
    const meta = (jwks_uri: string) =>
      vi.fn(async (u: string | URL | Request) =>
        String(u).endsWith("/.well-known/openid-configuration")
          ? new Response(JSON.stringify({ jwks_uri }))
          : new Response(JSON.stringify({ keys: [jwk] })),
      ) as unknown as typeof fetch;
    const evil = createIdentityVerifier({ issuer: ISSUER, audience: AUDIENCE, fetch: meta("http://evil.test/jwks") });
    await expect(evil.verify(await idToken(k))).rejects.toThrow(/origin/);
    const down = createIdentityVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      fetch: vi.fn(async () => new Response("no", { status: 503 })) as unknown as typeof fetch,
    });
    await expect(down.verify(await idToken(k))).rejects.toThrow(/503/);
  });
});

describe("who may call the admin API", () => {
  const verifier = {
    verify: async (t: string) => (t.split(".").length === 3 ? "dev-admin" : Promise.reject(new Error("bad"))),
  };
  const make = (over: Partial<Parameters<typeof createAdminAuth>[0]> = {}) =>
    createAdminAuth({
      staticToken: STATIC,
      identity: verifier,
      holdsRole: async (_r, s) => s === "dev-admin",
      ...over,
    });

  it("the static token is the CLI, audited as 'admin'", async () => {
    expect(await make()(`Bearer ${STATIC}`)).toEqual({ actor: "admin", kind: "cli" });
  });

  it("a person with core.admin is audited as user:<sub>", async () => {
    expect(await make()("Bearer a.b.c")).toEqual({ actor: "user:dev-admin", kind: "user", subject: "dev-admin" });
  });

  it("a valid person without core.admin is 403 (forbidden), checked live", async () => {
    await expect(make({ holdsRole: async () => false })("Bearer a.b.c")).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
  });

  it("no header, the wrong scheme, garbage and a wrong static token are 401", async () => {
    for (const h of [
      undefined,
      "",
      "Basic abc",
      "Bearer ",
      `Bearer ${"x".repeat(40)}`,
      "Bearer not.jwt",
      "Bearer a.b.c.d",
    ]) {
      await expect(make()(h), String(h)).rejects.toMatchObject({ status: 401 });
    }
  });

  it("an identity token that doesn't verify is 401, with no detail leaked", async () => {
    const bad = make({ identity: { verify: async () => Promise.reject(new Error("secret detail")) } });
    const err = await bad("Bearer a.b.c").catch((e) => e);
    expect(err).toMatchObject({ status: 401 });
    expect(String(err.message)).not.toContain("secret detail");
  });

  it("with the static token switched off it is refused, and people still work", async () => {
    const a = make({ staticToken: undefined });
    await expect(a(`Bearer ${STATIC}`)).rejects.toMatchObject({ status: 401 });
    expect((await a("Bearer a.b.c")).actor).toBe("user:dev-admin");
  });

  it("without an identity verifier only the static token works", async () => {
    const a = make({ identity: undefined });
    await expect(a("Bearer a.b.c")).rejects.toMatchObject({ status: 401 });
    expect((await a(`Bearer ${STATIC}`)).actor).toBe("admin");
  });
});

describe("the admin token setting", () => {
  it("is required and 32+ characters, unless switched off", () => {
    expect(parseAdminToken({ CORE_API_ADMIN_TOKEN: STATIC })).toBe(STATIC);
    expect(() => parseAdminToken({})).toThrow(/not set/);
    expect(() => parseAdminToken({ CORE_API_ADMIN_TOKEN: "short" })).toThrow(/32/);
    expect(parseAdminToken({ CORE_API_ADMIN_TOKEN_DISABLED: "true" })).toBeUndefined();
    expect(parseAdminToken({ CORE_API_ADMIN_TOKEN_DISABLED: "true", CORE_API_ADMIN_TOKEN: STATIC })).toBeUndefined();
    // only the exact word switches it off
    expect(() => parseAdminToken({ CORE_API_ADMIN_TOKEN_DISABLED: "1" })).toThrow(/not set/);
  });
});
