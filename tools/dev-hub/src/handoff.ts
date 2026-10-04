/**
 * The Hub side of the sign-in hand-off, for local development only (same
 * contract as asafarim-platform's apps/hub/lib/oidc-handoff.ts and
 * core/identity/src/handoff.ts):
 *
 *   ticket     identity → hub   EdDSA  iss=id  aud=hub  uid, nonce   exp ≤ 120 s
 *   assertion  hub → identity   EdDSA  iss=hub aud=id   sub, uid, jti exp ≤ 60 s
 */
import { randomBytes } from "node:crypto";
import { SignJWT, importJWK, jwtVerify, type CryptoKey, type JWK, type KeyObject } from "jose";

type Key = CryptoKey | KeyObject;

export async function importEd25519(json: string | undefined, name: string, kind: "public" | "private"): Promise<Key> {
  if (!json) throw new Error(`${name} is not set (run pnpm dev:keys)`);
  const jwk = JSON.parse(json) as JWK;
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") throw new Error(`${name} must be an Ed25519 JWK`);
  if ((kind === "public") === Boolean(jwk.d)) throw new Error(`${name} must be the ${kind} key`);
  return importJWK(jwk, "EdDSA") as Promise<Key>;
}

export async function verifyTicket(ticket: string, publicKey: Key): Promise<{ uid: string }> {
  const { payload } = await jwtVerify(ticket, publicKey, {
    algorithms: ["EdDSA"],
    issuer: "id",
    audience: "hub",
    requiredClaims: ["uid", "nonce", "iat", "exp"],
  });
  if ((payload.exp as number) - (payload.iat as number) > 120) throw new Error("ticket lifetime too long");
  if (typeof payload.uid !== "string" || !/^[\w-]{1,128}$/.test(payload.uid)) throw new Error("bad uid");
  return { uid: payload.uid };
}

export async function signAssertion(sub: string, uid: string, privateKey: Key): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return new SignJWT({ uid })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer("hub")
    .setAudience("id")
    .setSubject(sub)
    .setJti(randomBytes(16).toString("base64url"))
    .setIssuedAt(iat)
    .setExpirationTime(iat + 60)
    .sign(privateKey);
}
