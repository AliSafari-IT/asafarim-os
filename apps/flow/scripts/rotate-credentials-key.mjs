/**
 * Re-encrypt every Flow credential under the current key (lib/credentials/cipher.ts reencryptAll).
 *
 *   1. Generate a key: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.
 *   2. Give Flow FLOW_CREDENTIALS_KEY=<new>, FLOW_CREDENTIALS_KEY_VERSION=<old version + 1> and
 *      FLOW_CREDENTIALS_PREVIOUS_KEYS=<old version>:<old key>, and restart it: it reads both.
 *   3. Run this with the same three variables and DATABASE_URL:
 *      `node apps/flow/scripts/rotate-credentials-key.mjs`. One transaction: all rows or none.
 *   4. Remove FLOW_CREDENTIALS_PREVIOUS_KEYS and restart Flow.
 *
 * It prints how many rows it re-encrypted, never a key or a secret. Node 24 loads cipher.ts with type stripping.
 */
import pg from "pg";
import { keyringFromEnv, reencryptAll } from "../lib/credentials/cipher.ts";

const state = keyringFromEnv(process.env);
if (!state.ok) {
  console.error(`FLOW_CREDENTIALS_KEY is ${state.reason}: nothing re-encrypted.`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set: nothing re-encrypted.");
  process.exit(1);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const n = await reencryptAll(client, state.keyring);
  console.log(`Re-encrypted ${n} credential(s) under key version ${state.keyring.version}.`);
} catch (err) {
  console.error(`Nothing re-encrypted: ${err instanceof Error ? err.message : "failed"}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
