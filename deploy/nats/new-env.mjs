#!/usr/bin/env node
// Write core/nats/.env.production with what the production event bus needs (core/nats/.env.production.example), and add
// core-api's side of the same login to core/core-api/.env.production. Run it once, on a machine with this repository,
// after `pnpm env:decrypt:production` (core-api's env must be there), then `pnpm env:encrypt:production` and commit only
// the .age files.
//
//   node deploy/nats/new-env.mjs
//
// It generates ONE auth callout issuer key and ONE password:
//   core/nats/.env.production       NATS_AUTH_ISSUER (the PUBLIC key) and NATS_CORE_PASSWORD
//   core/core-api/.env.production   CORE_API_NATS_USER, CORE_API_NATS_PASSWORD and CORE_API_NATS_ISSUER_SEED (the
//                                   private half). core-api ignores all three until CORE_API_NATS_URL is set, which
//                                   the second pull request of asafarim-os#259 does in deploy/compose.prod.yml.
// It prints file NAMES, never a value. It refuses to overwrite core/nats/.env.production, and refuses to run when
// core-api's env already names any CORE_API_NATS_ variable: two different keys would never match. It changes nothing
// unless it can write both.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccount } from "@nats-io/nkeys";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The login core-api uses on the bus (`core` in deploy/nats/nats.conf). */
export const CORE_USER = "core";

/** URL-safe random text: no character that needs escaping in a dotenv file, a shell or the NATS config. */
const secret = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** The bus's env and core-api's lines, sharing one issuer key and one password. */
export function newEnv() {
  const issuer = createAccount();
  const password = secret();
  return {
    nats: [`NATS_AUTH_ISSUER=${issuer.getPublicKey()}`, `NATS_CORE_PASSWORD=${password}`, ""].join("\n"),
    coreApi: [
      `CORE_API_NATS_USER=${CORE_USER}`,
      `CORE_API_NATS_PASSWORD=${password}`,
      `CORE_API_NATS_ISSUER_SEED=${new TextDecoder().decode(issuer.getSeed())}`,
      "",
    ].join("\n"),
  };
}

/** Write both files; returns an error message (nothing written) or undefined. */
export function writeEnv({
  natsFile = path.join(root, "core/nats/.env.production"),
  coreApiFile = path.join(root, "core/core-api/.env.production"),
} = {}) {
  const rel = (p) => path.relative(root, p);
  if (!existsSync(coreApiFile))
    return `${rel(coreApiFile)} does not exist: run pnpm env:decrypt:production first (core-api needs the other half of the key).`;
  const coreApiText = readFileSync(coreApiFile, "utf8");
  if (/^CORE_API_NATS_/m.test(coreApiText))
    return `${rel(coreApiFile)} already names a CORE_API_NATS_ variable: not replacing it. Remove those lines first only if no deploy has used them.`;
  const env = newEnv();
  // "wx" creates the file or fails if it exists, in one step: no window between a check and the write.
  try {
    writeFileSync(natsFile, env.nats, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    return `${rel(natsFile)} already exists: not overwriting it. Delete it first only if no deploy has used it.`;
  }
  const separator = coreApiText === "" || coreApiText.endsWith("\n") ? "" : "\n";
  appendFileSync(
    coreApiFile,
    `${separator}# core-api's login on the event bus (deploy/README.md, the event bus). Inert until CORE_API_NATS_URL is set.\n${env.coreApi}`,
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
    "Wrote core/nats/.env.production (mode 600) and added CORE_API_NATS_USER, CORE_API_NATS_PASSWORD and CORE_API_NATS_ISSUER_SEED to core/core-api/.env.production. Next: pnpm env:encrypt:production, then commit core/nats/.env.production.age and core/core-api/.env.production.age.",
  );
}
