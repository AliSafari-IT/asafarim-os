#!/usr/bin/env node
// Write apps/flow/.env.production with the secrets Flow needs in production, generated at random
// (apps/flow/.env.production.example lists them), and give identity the same `flow` client secret. Run it once, on a
// machine with this repository, after `pnpm env:decrypt:production` (so core/identity/.env.production exists), then
// `pnpm env:encrypt:production` and commit only the .age files.
//
//   node deploy/flow/new-env.mjs
//
// It prints file NAMES, never a value. It refuses to overwrite apps/flow/.env.production, and refuses to run when
// identity's env already names IDENTITY_CLIENT_SECRET_FLOW: two different secrets would never match. It changes
// nothing unless it can write both.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The name identity reads the `flow` client's secret from (its `client_secret_env` in clients.json). */
export const IDENTITY_SECRET_NAME = "IDENTITY_CLIENT_SECRET_FLOW";

/** URL-safe random text: no character that needs escaping in a URL, a dotenv file or a shell. */
const secret = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Flow's env file and identity's line, sharing one client secret. */
export function newEnv() {
  const clientSecret = secret();
  return {
    flow: [`AUTH_SECRET=${secret(33)}`, `OIDC_CLIENT_SECRET=${clientSecret}`, ""].join("\n"),
    identity: `${IDENTITY_SECRET_NAME}=${clientSecret}\n`,
  };
}

/** Write both files; returns an error message (nothing written) or undefined. */
export function writeEnv({
  flowFile = path.join(root, "apps/flow/.env.production"),
  identityFile = path.join(root, "core/identity/.env.production"),
} = {}) {
  const rel = (p) => path.relative(root, p);
  if (!existsSync(identityFile))
    return `${rel(identityFile)} does not exist: run pnpm env:decrypt:production first (identity needs the same client secret).`;
  const identityText = readFileSync(identityFile, "utf8");
  if (new RegExp(`^${IDENTITY_SECRET_NAME}=`, "m").test(identityText))
    return `${rel(identityFile)} already has ${IDENTITY_SECRET_NAME}: not replacing it. Remove it first only if no deploy has used it.`;
  const env = newEnv();
  // "wx" creates the file or fails if it exists, in one step: no window between a check and the write.
  try {
    writeFileSync(flowFile, env.flow, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    return `${rel(flowFile)} already exists: not overwriting it. Delete it first only if no deploy has used it.`;
  }
  const separator = identityText === "" || identityText.endsWith("\n") ? "" : "\n";
  appendFileSync(
    identityFile,
    `${separator}# The flow client (deploy/README.md, flow.asafarim.site).\n${env.identity}`,
  );
  return undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const error = writeEnv();
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(
    `Wrote apps/flow/.env.production (mode 600) and added ${IDENTITY_SECRET_NAME} to core/identity/.env.production. Next: pnpm env:encrypt:production, then commit apps/flow/.env.production.age and core/identity/.env.production.age.`,
  );
}
