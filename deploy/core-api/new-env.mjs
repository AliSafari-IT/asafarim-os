#!/usr/bin/env node
// Write core/core-api/.env.production with every value core-api needs in production, generated at random
// (core/core-api/.env.production.example lists them). Run it once, on a machine with this repository, then
// `pnpm env:encrypt:production` and commit only core/core-api/.env.production.age.
//
//   node deploy/core-api/new-env.mjs [<output file>]
//
// It prints the file's NAME, never a value, and refuses to overwrite an existing file (the passwords only take
// effect on os-postgres's first start, so a second, different set would not match the database).
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.resolve(process.argv[2] ?? path.join(root, "core/core-api/.env.production"));

/** URL-safe random text: no character that needs escaping in a URL, a dotenv file or a shell. */
const secret = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function newEnv() {
  const superuser = secret();
  const core = secret();
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  jwk.kid = `core-api-${new Date().toISOString().slice(0, 10)}-${secret(4)}`;
  return [
    `POSTGRES_PASSWORD=${superuser}`,
    `CORE_API_DB_PASSWORD=${core}`,
    `CORE_API_DATABASE_URL=postgres://core_api:${core}@os-postgres:5432/core`,
    `CORE_API_PROVISIONER_URL=postgres://postgres:${superuser}@os-postgres:5432/postgres`,
    `CORE_API_ADMIN_TOKEN=${secret(36)}`,
    `CORE_API_TOKEN_SIGNING_JWK=${JSON.stringify(jwk)}`,
    "",
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (existsSync(out)) {
    console.error(
      `${path.relative(root, out)} already exists: not overwriting it. Delete it first only if no deploy has used it.`,
    );
    process.exit(1);
  }
  writeFileSync(out, newEnv(), { mode: 0o600, flag: "wx" });
  console.log(
    `Wrote ${path.relative(root, out)} (mode 600). Next: pnpm env:encrypt:production, then commit core/core-api/.env.production.age.`,
  );
}
