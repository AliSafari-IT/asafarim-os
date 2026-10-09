#!/usr/bin/env node
/**
 * `pnpm dev:keys` (OS-D1, #26): throwaway DEV keys and passwords for the local
 * OS, written to the git-ignored `.dev/` folder. Never used anywhere else.
 * Existing files are kept (so sessions survive restarts); `--force` replaces them.
 *
 *   .dev/identity.env   core/identity (node --env-file)
 *   .dev/dev-hub.env    tools/dev-hub, the dev login stub
 *   .dev/db.env         the bootstrap's database passwords
 *   .dev/clients.json   one public dev OIDC client ("dev-app") and one per app
 *   .dev/gateway.env    where the dev gateway (Caddy, compose.dev.yml) finds each service
 *   .dev/admin.env      the Admin console's own settings (the seeded users it can search)
 *   .dev/app.env        shared by the apps under apps/* (core-api, identity, the bus)
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const DEV_DIR = path.join(ROOT, ".dev");

export const DEV = {
  identityPort: 4010,
  coreApiPort: 4020,
  devHubPort: 4000,
  // The dev gateway (P3.3a): <id>.localhost:8080 for each app, id.localhost / api.localhost for the core.
  gatewayPort: 8080,
  // The Admin console (core/admin): a core service, not an app. Its OIDC client id is what core-api
  // accepts ID tokens for; in the gateway it is core.localhost.
  adminPort: 4030,
  adminClientId: "core-admin",
  // The smoke test's OIDC client: its callback is never served (it only reads the redirect).
  devClientCallback: "http://localhost:4199/callback",
  // Dev ports of the apps under apps/*; each gets an OIDC client in .dev/clients.json.
  apps: { notes: 4100 },
  postgres: { host: "127.0.0.1", port: 55440, adminUser: "postgres", adminPassword: "postgres-dev-only" },
  redisUrl: "redis://127.0.0.1:56380/3",
  // P4.1: the event bus (NATS JetStream, compose.dev.yml).
  natsUrl: "nats://127.0.0.1:54222",
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

/** core-api's dev env (P3.1): its own database role, the provisioner, the admin token. */
function ensureCoreApiEnv(force) {
  const file = path.join(DEV_DIR, "core-api.env");
  if (!force && existsSync(file)) return false;
  const pg = DEV.postgres;
  const dbPassword = secret();
  writeFileSync(
    file,
    [
      "# core/core-api in local development (pnpm dev). Throwaway values.",
      line("NODE_ENV", "development"),
      line("PORT", String(DEV.coreApiPort)),
      line("CORE_API_URL", `http://localhost:${DEV.coreApiPort}`),
      line("CORE_API_DB_PASSWORD", dbPassword),
      line("CORE_API_DATABASE_URL", `postgres://core_api:${dbPassword}@${pg.host}:${pg.port}/core`),
      // App install creates databases and roles: locally the dev superuser does it.
      line("CORE_API_PROVISIONER_URL", `postgres://${pg.adminUser}:${pg.adminPassword}@${pg.host}:${pg.port}/postgres`),
      line("CORE_API_ADMIN_TOKEN", randomBytes(32).toString("base64url")),
      tokenKeyLine(),
      ...coreApiAdminLines(),
      "",
    ].join("\n"),
  );
  return true;
}

/** How core-api knows the Admin console's people (P3.3b) and where an app opens in the launcher. */
function coreApiAdminLines() {
  return [
    line("CORE_API_IDENTITY_ISSUER", ISSUER),
    line("CORE_API_ADMIN_CLIENT_ID", DEV.adminClientId),
    line("CORE_API_APP_URL_TEMPLATE", `http://{id}.localhost:${DEV.gatewayPort}`),
    // P4.1: install creates the stream of an app that publishes events.
    line("CORE_API_NATS_URL", DEV.natsUrl),
  ];
}

/** core-api's access-token signing key (P3.3a): an Ed25519 private JWK with a kid. Throwaway, dev only. */
function tokenKeyLine() {
  return line("CORE_API_TOKEN_SIGNING_JWK", { ...edPair().priv, kid: `dev-token-${Date.now()}` });
}

/**
 * An env file written by an earlier version lacks settings added since (the token key, the admin
 * settings): add each missing one and keep everything else. Returns true when it added anything.
 */
function ensureCoreApiSettings(file) {
  return addMissingLines(file, [tokenKeyLine(), ...coreApiAdminLines()]);
}

/** mkdir/writeFile modes don't change an EXISTING path: tighten .dev/ and every file in it. */
export function lockDownDevDir() {
  chmodSync(DEV_DIR, 0o700);
  for (const f of readdirSync(DEV_DIR)) chmodSync(path.join(DEV_DIR, f), 0o600);
}

export function ensureDevKeys({ force = false, log = console.log } = {}) {
  mkdirSync(DEV_DIR, { recursive: true, mode: 0o700 });
  const coreApi = ensureCoreApiEnv(force) || ensureCoreApiSettings(path.join(DEV_DIR, "core-api.env"));
  try {
    return ensureDevKeysInner({ force, log, coreApi });
  } finally {
    lockDownDevDir();
  }
}

/** The dev OIDC clients: public (PKCE only), no secrets, so it's rewritten on every run. */
function writeClients() {
  const clients = [
    {
      client_id: "dev-app",
      primary_domain: "localhost",
      redirect_uris: [DEV.devClientCallback],
      post_logout_redirect_uris: ["http://localhost:4199/"],
    },
    // The Admin console: a public client too. Directly (localhost:4030) and through the dev gateway.
    {
      client_id: DEV.adminClientId,
      primary_domain: "localhost",
      redirect_uris: [
        `http://localhost:${DEV.adminPort}/api/auth/callback/asafarim`,
        `http://core.localhost:${DEV.gatewayPort}/api/auth/callback/asafarim`,
      ],
      post_logout_redirect_uris: [
        `http://localhost:${DEV.adminPort}/signin`,
        `http://core.localhost:${DEV.gatewayPort}/signin`,
      ],
    },
    // Each app is reachable directly (localhost:<port>) and through the dev gateway (<id>.localhost:8080).
    ...Object.entries(DEV.apps).map(([id, port]) => {
      const gateway = `http://${id}.localhost:${DEV.gatewayPort}`;
      return {
        client_id: id,
        primary_domain: "localhost",
        redirect_uris: [`http://localhost:${port}/api/auth/callback/asafarim`, `${gateway}/api/auth/callback/asafarim`],
        post_logout_redirect_uris: [`http://localhost:${port}/`, `${gateway}/`],
      };
    }),
  ];
  writeFileSync(path.join(DEV_DIR, "clients.json"), JSON.stringify({ clients }, null, 2) + "\n");
}

/** The env var holding an app's upstream in the generated gateway (see gatewayUpstreamVar in tools/platform-cli). */
export const upstreamVar = (appId) => `OS_APP_${appId.toUpperCase().replace(/-/g, "_")}_UPSTREAM`;

/**
 * Where the dev gateway finds each service. The gateway runs in a container, so the
 * services (on the host) are reached as host.docker.internal; OS_GATEWAY_HOST overrides
 * that for a gateway running directly on the host. Rewritten every run: it's only ports.
 */
export function writeGatewayEnv(host = process.env.OS_GATEWAY_HOST || "host.docker.internal") {
  const lines = [
    "# The dev gateway's upstreams (pnpm dev). Written on every run.",
    line("OS_IDENTITY_UPSTREAM", `${host}:${DEV.identityPort}`),
    line("OS_CORE_API_UPSTREAM", `${host}:${DEV.coreApiPort}`),
    line("OS_ADMIN_UPSTREAM", `${host}:${DEV.adminPort}`),
    ...Object.entries(DEV.apps).map(([id, port]) => line(upstreamVar(id), `${host}:${port}`)),
    "",
  ];
  writeFileSync(path.join(DEV_DIR, "gateway.env"), lines.join("\n"));
}

/** The Admin console's own env (.dev/admin.env): the seeded synthetic users it can search when granting roles. */
function writeAdminEnv() {
  writeFileSync(
    path.join(DEV_DIR, "admin.env"),
    [
      "# core/admin in local development (pnpm dev). Written on every run.",
      line("ADMIN_OIDC_CLIENT_ID", DEV.adminClientId),
      line("ADMIN_USER_DIRECTORY_FILE", path.join(ROOT, "tools/dev-hub/seed-users.json")),
      "",
    ].join("\n"),
  );
}

/** Settings added to .dev/app.env after it was first written: an older file gains them on the next run. */
const appEnvAdditions = () => [
  // P4.1: the outbox relay publishes to the dev bus.
  line("ASAFARIM_NATS_URL", DEV.natsUrl),
];

/** Append each `KEY=…` line whose key the file doesn't set yet. Returns true when it added anything. */
export function addMissingLines(file, wanted) {
  const text = readFileSync(file, "utf8");
  const missing = wanted.filter((l) => !new RegExp(`^${l.split("=")[0]}=`, "m").test(text));
  if (missing.length === 0) return false;
  writeFileSync(file, `${text.endsWith("\n") ? text : `${text}\n`}${missing.join("\n")}\n`);
  return true;
}

/** Env shared by every app under apps/* in development (.dev/app.env). */
function ensureAppEnv(force) {
  const file = path.join(DEV_DIR, "app.env");
  if (!force && existsSync(file)) {
    addMissingLines(file, appEnvAdditions());
    return;
  }
  writeFileSync(
    file,
    [
      "# Shared by the apps under apps/* in local development (pnpm dev). Throwaway values.",
      line("CORE_API_URL", `http://localhost:${DEV.coreApiPort}`),
      line("OIDC_ISSUER", ISSUER),
      line("AUTH_SECRET", randomBytes(32).toString("base64url")),
      line("AUTH_TRUST_HOST", "true"),
      // Permission changes show up within a second instead of the production 60 s.
      line("ASAFARIM_ACCESS_TTL_MS", "1000"),
      ...appEnvAdditions(),
      "",
    ].join("\n"),
  );
}

function ensureDevKeysInner({ force, log, coreApi }) {
  writeClients();
  writeGatewayEnv();
  writeAdminEnv();
  ensureAppEnv(force);
  const files = ["identity.env", "dev-hub.env", "db.env", "clients.json"].map((f) => path.join(DEV_DIR, f));
  if (!force && files.every((f) => existsSync(f))) {
    log(`dev keys: present in .dev/${coreApi ? " (core-api.env added)" : ""} (pnpm dev:keys --force to replace)`);
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
