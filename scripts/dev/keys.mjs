#!/usr/bin/env node
/**
 * `pnpm dev:keys` (OS-D1, #26): throwaway DEV keys and passwords for the local
 * OS, written to the git-ignored `.dev/` folder. Never used anywhere else.
 * Existing files are kept (so sessions survive restarts); `--force` replaces them.
 *
 *   .dev/identity.env   core/identity (node --env-file)
 *   .dev/dev-hub.env    tools/dev-hub, the dev login stub
 *   .dev/db.env         the bootstrap's database passwords
 *   .dev/clients.json   one public dev OIDC client ("dev-app")
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const DEV_DIR = path.join(ROOT, ".dev");

export const DEV = {
  identityPort: 4010,
  devHubPort: 4000,
  devClientCallback: "http://localhost:4100/callback",
  postgres: { host: "127.0.0.1", port: 55440, adminUser: "postgres", adminPassword: "postgres-dev-only" },
  redisUrl: "redis://127.0.0.1:56380/3",
};
export const ISSUER = `http://localhost:${DEV.identityPort}`;

const secret = () => randomBytes(24).toString("base64url");
const jwk = (key) => key.export({ format: "jwk" });

function edPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: jwk(privateKey), pub: jwk(publicKey) };
}

/** KEY='json' lines: node --env-file reads single-quoted values verbatim. */
const line = (k, v) => `${k}=${typeof v === "string" ? v : `'${JSON.stringify(v)}'`}`;

export function ensureDevKeys({ force = false, log = console.log } = {}) {
  mkdirSync(DEV_DIR, { recursive: true });
  const files = ["identity.env", "dev-hub.env", "db.env", "clients.json"].map((f) => path.join(DEV_DIR, f));
  if (!force && files.every((f) => existsSync(f))) {
    log("dev keys: present in .dev/ (pnpm dev:keys --force to replace)");
    return;
  }

  const signing = {
    ...jwk(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey),
    kid: `dev-${Date.now()}`,
    alg: "ES256",
    use: "sig",
  };
  const ticket = edPair(); // identity → dev hub
  const assertion = edPair(); // dev hub → identity
  const identityRoPassword = secret();
  const pg = DEV.postgres;

  writeFileSync(
    path.join(DEV_DIR, "db.env"),
    [
      "# Dev-only database passwords (pnpm dev:keys). Local Postgres on 127.0.0.1 only.",
      line("POSTGRES_ADMIN_URL", `postgres://${pg.adminUser}:${pg.adminPassword}@${pg.host}:${pg.port}/postgres`),
      line("OS_ACCOUNTS_PASSWORD", secret()),
      line("IDENTITY_RO_PASSWORD", identityRoPassword),
      "",
    ].join("\n"),
  );

  writeFileSync(
    path.join(DEV_DIR, "clients.json"),
    JSON.stringify(
      {
        clients: [
          {
            client_id: "dev-app",
            primary_domain: "localhost",
            redirect_uris: [DEV.devClientCallback],
            post_logout_redirect_uris: ["http://localhost:4100/"],
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(
    path.join(DEV_DIR, "identity.env"),
    [
      "# core/identity in local development (pnpm dev). Throwaway keys.",
      line("NODE_ENV", "development"),
      line("PORT", String(DEV.identityPort)),
      line("IDENTITY_ISSUER", ISSUER),
      line("IDENTITY_HUB_CONTINUE_URL", `http://localhost:${DEV.devHubPort}/oidc/continue`),
      line("IDENTITY_REDIS_URL", DEV.redisUrl),
      line(
        "IDENTITY_ACCOUNTS_DATABASE_URL",
        `postgres://identity_ro:${identityRoPassword}@${pg.host}:${pg.port}/os_accounts`,
      ),
      line("IDENTITY_OIDC_JWKS", { keys: [signing] }),
      line("IDENTITY_COOKIE_KEYS", randomBytes(32).toString("base64url")),
      line("IDENTITY_HANDOFF_PRIVATE_JWK", ticket.priv),
      line("IDENTITY_HUB_PUBLIC_JWK", assertion.pub),
      line("IDENTITY_CLIENTS_FILE", path.join(DEV_DIR, "clients.json")),
      line("IDENTITY_TRUST_PROXY", "false"),
      "",
    ].join("\n"),
  );

  writeFileSync(
    path.join(DEV_DIR, "dev-hub.env"),
    [
      "# tools/dev-hub, the dev login stub (pnpm dev). Throwaway keys.",
      line("NODE_ENV", "development"),
      line("DEV_HUB_PORT", String(DEV.devHubPort)),
      line("DEV_HUB_IDENTITY_ISSUER", ISSUER),
      line("DEV_HUB_TICKET_PUBLIC_JWK", ticket.pub),
      line("DEV_HUB_ASSERTION_PRIVATE_JWK", assertion.priv),
      "",
    ].join("\n"),
  );
  log(`dev keys: ${force ? "replaced" : "created"} in .dev/ (git-ignored)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureDevKeys({ force: process.argv.includes("--force") });
}
