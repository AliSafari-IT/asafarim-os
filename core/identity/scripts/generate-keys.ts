/**
 * Prints fresh keys for the identity service, as env lines for the
 * deployment's encrypted env file. Run: `pnpm --filter @asafarim/identity keys`.
 *
 *   --signing-only   just a new OIDC signing key (for a rotation, see README)
 *
 * The output contains private keys: put it straight into the encrypted env,
 * never into a commit, an issue or a chat.
 */
import { randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";

async function signingKey() {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const kid = `es256-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString("hex")}`;
  return { ...(await exportJWK(privateKey)), kid, alg: "ES256", use: "sig" };
}

async function ed25519() {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  return { privateJwk: await exportJWK(privateKey), publicJwk: await exportJWK(publicKey) };
}

const key = await signingKey();
if (process.argv.includes("--signing-only")) {
  console.log(JSON.stringify(key));
} else {
  const handoff = await ed25519();
  console.log(`IDENTITY_OIDC_JWKS='${JSON.stringify({ keys: [key] })}'`);
  console.log(`IDENTITY_COOKIE_KEYS=${randomBytes(32).toString("base64url")}`);
  console.log(`IDENTITY_HANDOFF_PRIVATE_JWK='${JSON.stringify(handoff.privateJwk)}'`);
  console.log(`# Give Hub this public key (Hub pins it to verify tickets):`);
  console.log(`HUB_IDENTITY_TICKET_PUBLIC_JWK='${JSON.stringify(handoff.publicJwk)}'`);
  console.log(
    `# IDENTITY_HUB_PUBLIC_JWK comes from Hub's own key pair (Hub generates it; only the public half comes here).`,
  );
}
