import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  jwksOf,
  signAccessToken,
  verificationKeyOf,
  verifyAccessToken,
  type SigningKey,
} from "./index.ts";

function newKey(kid = "k1"): SigningKey {
  return { kid, privateJwk: generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }) };
}
const NOW = new Date("2026-10-04T12:00:00Z");
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

function issue(key = newKey(), over: Partial<Parameters<typeof signAccessToken>[0]> = {}) {
  const { token, claims } = signAccessToken({
    key,
    subject: "dev-member",
    audience: "notes",
    permissions: ["notes.write", "notes.read"],
    now: NOW,
    ...over,
  });
  return { key, token, claims, keys: [verificationKeyOf(key)] };
}

describe("access tokens", () => {
  it("round-trips: the subject, audience and sorted permissions, for 60 s", () => {
    const { token, keys, claims } = issue();
    expect(claims.exp - claims.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
    const r = verifyAccessToken(token, { keys, audience: "notes", now: at(1) });
    expect(r).toEqual({ ok: true, claims });
    expect(claims.perms).toEqual(["notes.read", "notes.write"]);
  });

  it("expires after its lifetime (plus a few seconds of clock skew), not before", () => {
    const { token, keys } = issue();
    expect(verifyAccessToken(token, { keys, audience: "notes", now: at(59) }).ok).toBe(true);
    expect(verifyAccessToken(token, { keys, audience: "notes", now: at(60 + 4) }).ok).toBe(true);
    expect(verifyAccessToken(token, { keys, audience: "notes", now: at(60 + 6) })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("is for one app: another app's audience is refused", () => {
    const { token, keys } = issue();
    expect(verifyAccessToken(token, { keys, audience: "tasks", now: at(1) })).toEqual({
      ok: false,
      reason: "wrong_audience",
    });
  });

  it("refuses a token signed by another key, even with the same kid", () => {
    const { token } = issue(newKey("k1"));
    const other = [verificationKeyOf(newKey("k1"))];
    expect(verifyAccessToken(token, { keys: other, audience: "notes", now: at(1) })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses an unknown kid", () => {
    const { token } = issue(newKey("k1"));
    const other = [verificationKeyOf(newKey("k2"))];
    expect(verifyAccessToken(token, { keys: other, audience: "notes", now: at(1) })).toEqual({
      ok: false,
      reason: "unknown_key",
    });
  });

  it("refuses a tampered payload (extra permissions)", () => {
    const { token, keys } = issue(newKey(), { permissions: ["notes.read"] });
    const [h, p, s] = token.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    claims.perms.push("notes.write");
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
    expect(verifyAccessToken(forged, { keys, audience: "notes", now: at(1) })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses alg none and any other algorithm", () => {
    const { token, keys } = issue();
    const [, p] = token.split(".") as [string, string, string];
    for (const alg of ["none", "HS256", "ES256"]) {
      const h = Buffer.from(JSON.stringify({ alg, typ: "JWT", kid: "k1" })).toString("base64url");
      expect(verifyAccessToken(`${h}.${p}.AAAA`, { keys, audience: "notes", now: at(1) })).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("refuses garbage without throwing", () => {
    const { keys } = issue();
    for (const t of ["", "a.b", "a.b.c.d", "not a token", "....", "x".repeat(10_000), "\u0000.\u0000.\u0000"]) {
      expect(verifyAccessToken(t, { keys, audience: "notes", now: at(1) }).ok).toBe(false);
    }
  });

  it("publishes only the public half in the JWKS", () => {
    const key = newKey("k9");
    const jwks = jwksOf([verificationKeyOf(key)]);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", kid: "k9", alg: "EdDSA", use: "sig" });
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });
});
