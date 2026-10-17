// The production stack's compose file and site file (asafarim-os#45; os-site and asafarim.site: #70; os-docs and
// docs.asafarim.site: #83). Compose parses the file, not a regex:
// these tests read `docker compose config --format json`, the model Compose itself will run.
//
//   node --test deploy/compose.prod.test.mjs        (needs the docker CLI; no daemon, no network)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeText = readFileSync(path.join(root, "deploy", "compose.prod.yml"), "utf8");
const siteText = readFileSync(path.join(root, "sites", "asafarim-os.caddy"), "utf8");
const nginxText = readFileSync(path.join(root, "core", "site", "nginx.conf"), "utf8");
const docsManifest = JSON.parse(readFileSync(path.join(root, "apps", "docs", "platform.app.json"), "utf8"));
const activeSite = siteText
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");

/** The site-only file (#97): the landing page without id.asafarim.site, for `vps-deploy.sh --site-only`. */
const siteOnlyText = readFileSync(path.join(root, "sites", "asafarim-os-site.caddy"), "utf8");
const activeSiteOnly = siteOnlyText
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");

/** One top-level block of a site file, by its exact site address (comments removed). */
function siteBlock(address, text = activeSite) {
  const start = text.search(new RegExp(`^${address.replaceAll(".", "\\.")} \\{`, "m"));
  assert.ok(start >= 0, `the site file has no ${address} block`);
  const end = text.indexOf("\n}", start);
  return text.slice(start, end + 2);
}

/**
 * Render the compose file in a throwaway copy of the layout it expects: deploy/compose.prod.yml, and an EMPTY
 * ../.env.identity and ../.env.docs (Compose refuses a missing env_file, and the real ones hold secrets: never read
 * or print them).
 */
function render(
  env = { IMAGE_TAG: "testsha", SITE_IMAGE_TAG: "sitesha", DOCS_IMAGE_TAG: "docssha", CORE_API_IMAGE_TAG: "coresha" },
) {
  const dir = mkdtempSync(path.join(tmpdir(), "compose-prod-"));
  try {
    mkdirSync(path.join(dir, "deploy"));
    cpSync(path.join(root, "deploy", "compose.prod.yml"), path.join(dir, "deploy", "compose.prod.yml"));
    writeFileSync(path.join(dir, ".env.identity"), "");
    writeFileSync(path.join(dir, ".env.docs"), "");
    writeFileSync(path.join(dir, ".env.core-api"), "");
    mkdirSync(path.join(dir, "deploy", "core-api", "initdb"), { recursive: true });
    const run = spawnSync("docker", ["compose", "-f", "compose.prod.yml", "config", "--format", "json"], {
      cwd: path.join(dir, "deploy"),
      env: {
        ...process.env,
        IMAGE_TAG: "",
        SITE_IMAGE_TAG: "",
        DOCS_IMAGE_TAG: "",
        CORE_API_IMAGE_TAG: "coresha",
        COMPOSE_PROFILES: "",
        ...env,
      },
      encoding: "utf8",
    });
    return run;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rendered = render();
assert.equal(
  rendered.status,
  0,
  `docker compose config failed (is the docker CLI installed?):\n${rendered.stderr}${rendered.error ?? ""}`,
);
const config = JSON.parse(rendered.stdout);
const { identity, "os-redis": redis, "os-site": site, "os-docs": docs } = config.services;
const networkNames = (service) => Object.keys(service.networks ?? {}).sort();

test("the file renders as the asafarim-os project with exactly identity, os-redis, os-site and os-docs", () => {
  assert.equal(config.name, "asafarim-os");
  assert.deepEqual(Object.keys(config.services).sort(), ["identity", "os-docs", "os-redis", "os-site"]);
});

test("the image tag comes from IMAGE_TAG, and there is no default", () => {
  assert.equal(identity.image, "ghcr.io/alisafari-it/asafarim-os:identity-testsha");
  const unset = render({ IMAGE_TAG: "", SITE_IMAGE_TAG: "sitesha", DOCS_IMAGE_TAG: "docssha" });
  assert.notEqual(unset.status, 0, "a deploy without IMAGE_TAG must fail, not pull identity-");
  assert.match(unset.stderr, /IMAGE_TAG/);
});

test("os-site's image tag comes from SITE_IMAGE_TAG, and there is no default", () => {
  assert.equal(site.image, "ghcr.io/alisafari-it/asafarim-os:site-sitesha");
  const unset = render({ IMAGE_TAG: "testsha", SITE_IMAGE_TAG: "", DOCS_IMAGE_TAG: "docssha" });
  assert.notEqual(unset.status, 0, "a deploy without SITE_IMAGE_TAG must fail, not pull site-");
  assert.match(unset.stderr, /SITE_IMAGE_TAG/);
});

test("os-site is small and hardened: read_only, no capabilities, no-new-privileges, at most 32 MB and a CPU limit", () => {
  assert.equal(site.read_only, true);
  assert.deepEqual(site.cap_drop, ["ALL"]);
  assert.ok(site.security_opt.includes("no-new-privileges:true"));
  assert.ok(Number(site.mem_limit) > 0 && Number(site.mem_limit) <= 32 * 1024 * 1024, "os-site: mem_limit <= 32m");
  assert.ok(site.cpus > 0 && site.cpus <= 0.5);
  assert.ok(
    site.tmpfs?.some((t) => t.startsWith("/tmp")),
    "nginx's pid and temp files need a tmpfs /tmp",
  );
  assert.ok(!site.env_file, "os-site holds no secrets");
});

test("os-site is on edge_net ONLY, under the unique alias os-site", () => {
  assert.deepEqual(networkNames(site), ["edge_net"]);
  assert.deepEqual(site.networks.edge_net.aliases, ["os-site"]);
});

test("os-docs's image tag comes from DOCS_IMAGE_TAG, and there is no default (#83)", () => {
  assert.equal(docs.image, "ghcr.io/alisafari-it/asafarim-os:docs-docssha");
  const unset = render({ IMAGE_TAG: "testsha", SITE_IMAGE_TAG: "sitesha", DOCS_IMAGE_TAG: "" });
  assert.notEqual(unset.status, 0, "a deploy without DOCS_IMAGE_TAG must fail, not pull docs-");
  assert.match(unset.stderr, /DOCS_IMAGE_TAG/);
});

test("os-docs is hardened: read_only, no capabilities, no-new-privileges, the manifest's memory and CPU limits", () => {
  assert.equal(docs.read_only, true);
  assert.deepEqual(docs.cap_drop, ["ALL"]);
  assert.ok(docs.security_opt.includes("no-new-privileges:true"));
  assert.equal(docs.mem_limit, String(256 * 1024 * 1024));
  assert.equal(docsManifest.runtime.resources.memory, "256m");
  assert.equal(docs.cpus, docsManifest.runtime.resources.cpus);
  assert.ok(
    docs.tmpfs?.some((t) => t.startsWith("/tmp:")),
    "a read-only root needs a tmpfs /tmp",
  );
  assert.ok(
    docs.tmpfs?.some((t) => t.startsWith("/app/apps/docs/.next/cache:") && t.includes("uid=1000")),
    "Next's cache needs a tmpfs the node user can write",
  );
});

test("os-docs reads its secrets from ../.env.docs only, and signs in through id.asafarim.site (#83)", () => {
  assert.match(composeText, /env_file:\n\s+- \.\.\/\.env\.docs\n/);
  assert.equal(docs.environment.OIDC_ISSUER, identity.environment.IDENTITY_ISSUER);
  assert.equal(docs.environment.ASAFARIM_APP_ID, docsManifest.id);
  assert.equal(docs.environment.HOSTNAME, "0.0.0.0", "Next's standalone server binds to HOSTNAME");
  for (const name of ["AUTH_SECRET", ...docsManifest.secrets]) {
    assert.ok(!(name in docs.environment), `${name} is a secret: it belongs in .env.docs, never in the compose file`);
  }
});

test("os-docs is on edge_net under the unique alias os-docs, and on os_core for core-api: never os_net (identity's Redis)", () => {
  assert.deepEqual(networkNames(docs), ["edge_net", "os_core"]);
  assert.deepEqual(docs.networks.edge_net.aliases, ["os-docs"]);
});

test("os-docs finds core-api by its name on os_core; the credential stays in .env.docs", () => {
  assert.equal(docs.environment.CORE_API_URL, "http://os-core-api:4020");
  assert.ok(!("ASAFARIM_REGISTRY_CREDENTIAL" in docs.environment));
});

test("os-redis is on os_net ONLY: never on edge_net or identity_db", () => {
  assert.deepEqual(networkNames(redis), ["os_net"]);
});

test("without the core profile: core-api and its Postgres are not part of the stack, and nothing publishes a port", () => {
  assert.ok(!("os-core-api" in config.services) && !("os-postgres" in config.services));
  for (const [name, service] of Object.entries(config.services)) {
    assert.ok(!service.ports || service.ports.length === 0, `${name} publishes a port`);
  }
});

test("identity is hardened: read_only, every capability dropped, no-new-privileges, memory and CPU limits", () => {
  assert.equal(identity.read_only, true);
  assert.deepEqual(identity.cap_drop, ["ALL"]);
  assert.ok(identity.security_opt.includes("no-new-privileges:true"));
  assert.ok(
    Number(identity.mem_limit) > 0 && Number(identity.mem_limit) <= 256 * 1024 * 1024,
    "identity needs a mem_limit",
  );
  assert.ok(identity.cpus > 0, "identity needs a cpus limit");
  assert.ok(
    identity.tmpfs?.some((t) => t.startsWith("/tmp")),
    "a read-only root needs a tmpfs /tmp",
  );
});

test("os-redis has its limits, persists to a named volume, and never evicts", () => {
  assert.ok(Number(redis.mem_limit) > 0 && redis.cpus > 0);
  assert.ok(redis.security_opt.includes("no-new-privileges:true"));
  assert.ok(redis.volumes.some((v) => v.type === "volume" && v.source === "os_redis_data" && v.target === "/data"));
  assert.ok(config.volumes.os_redis_data);
  assert.deepEqual(
    redis.command.slice(redis.command.indexOf("--appendonly"), redis.command.indexOf("--appendonly") + 2),
    ["--appendonly", "yes"],
  );
  assert.ok(redis.command.includes("noeviction"), "a full Redis must fail loudly, not drop sessions");
  assert.match(redis.image, /^redis:\d+\.\d+-alpine$/, "pin a minor line, not a floating tag");
});

test("identity joins edge_net under the unique alias os-identity, identity_db, and its private os_net", () => {
  assert.deepEqual(networkNames(identity), ["edge_net", "identity_db", "os_net"]);
  assert.deepEqual(identity.networks.edge_net.aliases, ["os-identity"]);
});

test("edge_net and identity_db are external; os_net is this stack's own", () => {
  assert.equal(config.networks.edge_net.external, true);
  assert.equal(config.networks.edge_net.name, "edge_net");
  assert.equal(config.networks.identity_db.external, true);
  assert.equal(config.networks.identity_db.name, "identity_db");
  assert.ok(!config.networks.os_net.external);
});

test("identity's fixed settings point at this stack's own Redis (logical DB 3) and the public URLs", () => {
  assert.equal(identity.environment.IDENTITY_REDIS_URL, "redis://os-redis:6379/3");
  assert.equal(identity.environment.IDENTITY_ISSUER, "https://id.asafarim.site");
  assert.equal(identity.environment.IDENTITY_HUB_CONTINUE_URL, "https://hub.asafarim.com/oidc/continue");
  assert.equal(identity.environment.IDENTITY_CLIENTS_FILE, "/etc/identity/clients.json");
});

test("the client config is mounted read-only from deploy/identity/clients.json, which is not in git", () => {
  const mount = identity.volumes.find((v) => v.target === "/etc/identity/clients.json");
  assert.ok(mount, "identity must mount its client config");
  assert.equal(mount.type, "bind");
  assert.equal(mount.read_only, true);
  assert.match(mount.source.replaceAll("\\", "/"), /\/deploy\/identity\/clients\.json$|\/identity\/clients\.json$/);
});

test("the secrets come from ../.env.identity (decrypted at the repo root by vps-deploy.sh)", () => {
  assert.match(composeText, /env_file:\n\s+- \.\.\/\.env\.identity\n/);
});

test("the site file serves id.asafarim.site, asafarim.site and its www redirect, and docs.asafarim.site, nothing else", () => {
  const sites = [...activeSite.matchAll(/^([a-z0-9.*-]+)(?:, [a-z0-9.*-]+)*\s*\{/gm)].map((m) => m[1]);
  assert.deepEqual(sites.sort(), ["asafarim.site", "docs.asafarim.site", "id.asafarim.site", "www.asafarim.site"]);
  assert.match(siteBlock("www.asafarim.site"), /redir https:\/\/asafarim\.site\{uri\} 301/);
});

test("asafarim.site proxies to os-site's edge_net alias on the port its nginx listens on", () => {
  const upstream = /reverse_proxy ([\w-]+):(\d+)/.exec(siteBlock("asafarim.site"));
  assert.ok(upstream, "asafarim.site must reverse_proxy to os-site");
  assert.ok(site.networks.edge_net.aliases.includes(upstream[1]), `${upstream[1]} is not os-site's edge_net alias`);
  assert.match(nginxText, new RegExp(`^\\s*listen ${upstream[2]};`, "m"));
});

test("asafarim.site has the identity block's headers plus a strict CSP, the same CSP the container sends", () => {
  const block = siteBlock("asafarim.site");
  const id = siteBlock("id.asafarim.site");
  const hsts = /Strict-Transport-Security "([^"]+)"/;
  assert.equal(hsts.exec(block)?.[1], hsts.exec(id)?.[1]);
  assert.match(block, /X-Content-Type-Options nosniff/);
  // `defer`: the edge's values replace the container's instead of each header being sent twice.
  assert.match(block, /^\s*defer$/m);
  const csp = /Content-Security-Policy "([^"]+)"/.exec(block)?.[1] ?? "";
  for (const directive of [
    "default-src 'none'",
    "script-src 'self'",
    "connect-src https://id.asafarim.site",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ]) {
    assert.ok(csp.split("; ").includes(directive), `the CSP needs ${directive}`);
  }
  // The only other origin is identity, and only for session.js's /whoami.
  assert.doesNotMatch(
    csp.replace("connect-src https://id.asafarim.site", ""),
    /https?:|\*|'unsafe-/,
    "no other origins, wildcards or unsafe-* sources",
  );
  assert.equal(/add_header Content-Security-Policy "([^"]+)" always;/.exec(nginxText)?.[1], csp);
  assert.equal(/add_header Strict-Transport-Security "([^"]+)" always;/.exec(nginxText)?.[1], hsts.exec(block)?.[1]);
});

test("the site file proxies id.asafarim.site to identity's alias", () => {
  const upstream = /reverse_proxy ([\w-]+):(\d+)/.exec(siteBlock("id.asafarim.site"));
  assert.ok(upstream, "the site must reverse_proxy to identity");
  assert.ok(
    identity.networks.edge_net.aliases.includes(upstream[1]),
    `the site proxies to ${upstream[1]}, which is not identity's edge_net alias`,
  );
  assert.equal(upstream[2], "3000");
});

test("docs.asafarim.site proxies to os-docs's edge_net alias on the manifest's port, its primary domain (#83)", () => {
  assert.equal(docsManifest.domains.primary, "docs.asafarim.site");
  const upstream = /reverse_proxy ([\w-]+):(\d+)/.exec(siteBlock("docs.asafarim.site"));
  assert.ok(upstream, "docs.asafarim.site must reverse_proxy to os-docs");
  assert.ok(docs.networks.edge_net.aliases.includes(upstream[1]), `${upstream[1]} is not os-docs's edge_net alias`);
  assert.equal(Number(upstream[2]), docsManifest.runtime.port);
});

test("docs.asafarim.site has the landing page's HSTS, nosniff, no Referer, noindex, and no edge CSP", () => {
  const block = siteBlock("docs.asafarim.site");
  const hsts = /Strict-Transport-Security "([^"]+)"/;
  assert.equal(hsts.exec(block)?.[1], hsts.exec(siteBlock("asafarim.site"))?.[1]);
  assert.match(block, /X-Content-Type-Options nosniff/);
  assert.match(block, /Referrer-Policy no-referrer/);
  assert.match(block, /X-Frame-Options DENY/);
  assert.match(block, /X-Robots-Tag "noindex, nofollow"/);
  assert.match(block, /^\s*defer$/m);
  // The app's /api/files sets a sandboxing CSP on SVGs; an edge CSP under `defer` would replace it.
  assert.doesNotMatch(block, /Content-Security-Policy/i);
});

test("id.asafarim.site has no Content-Security-Policy of its own (identity sets a strict one per page)", () => {
  const active = siteBlock("id.asafarim.site");
  assert.doesNotMatch(active, /Content-Security-Policy/i);
  assert.match(active, /Strict-Transport-Security/);
  assert.match(active, /X-Content-Type-Options nosniff/);
});

test("the site-only file serves asafarim.site, its www redirect and docs.asafarim.site: no id.asafarim.site (#97, #83)", () => {
  const sites = [...activeSiteOnly.matchAll(/^([a-z0-9.*-]+)(?:, [a-z0-9.*-]+)*\s*\{/gm)].map((m) => m[1]);
  assert.deepEqual(sites.sort(), ["asafarim.site", "docs.asafarim.site", "www.asafarim.site"]);
  // No block or upstream for identity (the landing page's CSP may still name it as connect-src).
  assert.doesNotMatch(activeSiteOnly, /^\s*id\.asafarim\.site\b|os-identity/m);
});

test("the site-only file's landing and docs blocks are identical to the full site file's (#97, #83)", () => {
  for (const address of ["asafarim.site", "www.asafarim.site", "docs.asafarim.site"]) {
    assert.equal(
      siteBlock(address, activeSiteOnly),
      siteBlock(address),
      `${address} differs between the two site files`,
    );
  }
});

// ---- core-api and its Postgres: the "core" profile, which vps-deploy.sh turns on once core-api's env is committed.
const coreRendered = render({
  IMAGE_TAG: "testsha",
  SITE_IMAGE_TAG: "sitesha",
  DOCS_IMAGE_TAG: "docssha",
  CORE_API_IMAGE_TAG: "coresha",
  COMPOSE_PROFILES: "core",
});
assert.equal(coreRendered.status, 0, coreRendered.stderr);
const coreConfig = JSON.parse(coreRendered.stdout);
const { "os-core-api": coreApi, "os-postgres": postgres } = coreConfig.services;

test("the core profile adds exactly os-core-api and os-postgres", () => {
  assert.deepEqual(Object.keys(coreConfig.services).sort(), [
    "identity",
    "os-core-api",
    "os-docs",
    "os-postgres",
    "os-redis",
    "os-site",
  ]);
  assert.deepEqual(coreApi.profiles, ["core"]);
  assert.deepEqual(postgres.profiles, ["core"]);
});

test("core-api's image tag comes from CORE_API_IMAGE_TAG, and there is no default", () => {
  assert.equal(coreApi.image, "ghcr.io/alisafari-it/asafarim-os:core-api-coresha");
  const unset = render({ IMAGE_TAG: "t", SITE_IMAGE_TAG: "s", DOCS_IMAGE_TAG: "d", CORE_API_IMAGE_TAG: "" });
  assert.notEqual(unset.status, 0, "a deploy without CORE_API_IMAGE_TAG must fail, not pull core-api-");
  assert.match(unset.stderr, /CORE_API_IMAGE_TAG/);
});

test("os-postgres is Postgres 16 (core-api's pg_dump is 16), on os_core ONLY, persisted, with its init script", () => {
  assert.match(postgres.image, /^postgres:16(\.|-)/);
  assert.deepEqual(networkNames(postgres), ["os_core"]);
  assert.ok(!postgres.ports || postgres.ports.length === 0, "os-postgres publishes no port");
  const mounts = postgres.volumes.map((v) => `${v.source}:${v.target}`);
  assert.ok(
    mounts.some((m) => m.endsWith(":/var/lib/postgresql/data") && m.startsWith("os_pg_data")),
    mounts.join(),
  );
  assert.ok(postgres.volumes.some((v) => v.target === "/docker-entrypoint-initdb.d" && v.read_only));
  assert.ok(postgres.healthcheck?.test?.includes("pg_isready"));
  // TCP, not the socket: the first-start init's temporary server listens on the socket only.
  assert.deepEqual(
    postgres.healthcheck.test.slice(
      postgres.healthcheck.test.indexOf("-h"),
      postgres.healthcheck.test.indexOf("-h") + 2,
    ),
    ["-h", "127.0.0.1"],
  );
  assert.match(composeText, /os-postgres:[\s\S]*?env_file:\n\s+- \.\.\/\.env\.core-api\n/);
});

test("os-core-api is hardened, on os_core ONLY, and its admin API is on the VPS's loopback only", () => {
  assert.equal(coreApi.read_only, true);
  assert.deepEqual(coreApi.cap_drop, ["ALL"]);
  assert.ok(coreApi.security_opt.includes("no-new-privileges:true"));
  assert.ok(Number(coreApi.mem_limit) > 0 && coreApi.cpus > 0);
  assert.deepEqual(networkNames(coreApi), ["os_core"]);
  assert.deepEqual(coreApi.networks.os_core.aliases, ["os-core-api"]);
  assert.equal(coreApi.ports.length, 1);
  assert.equal(coreApi.ports[0].host_ip, "127.0.0.1", "never 0.0.0.0: the admin API is not public");
  assert.equal(String(coreApi.ports[0].published), "4020");
  assert.equal(coreApi.ports[0].target, 4020);
  assert.equal(coreApi.depends_on["os-postgres"].condition, "service_healthy");
  assert.ok(
    coreApi.volumes.some((v) => v.source === "os_core_api_backups" && v.target === "/var/lib/core-api/backups"),
  );
  assert.equal(coreApi.environment.CORE_API_APP_DB_HOST, "os-postgres");
  assert.equal(coreApi.environment.OS_APP_DOCS_UPSTREAM, "os-docs:3000");
  for (const name of [
    "CORE_API_ADMIN_TOKEN",
    "CORE_API_DATABASE_URL",
    "CORE_API_PROVISIONER_URL",
    "CORE_API_TOKEN_SIGNING_JWK",
  ]) {
    assert.ok(!(name in coreApi.environment), `${name} is a secret: it belongs in .env.core-api`);
  }
});

test("in the core profile, only os-core-api publishes a port, and only on 127.0.0.1", () => {
  for (const [name, service] of Object.entries(coreConfig.services)) {
    if (name === "os-core-api") continue;
    assert.ok(!service.ports || service.ports.length === 0, `${name} publishes a port`);
  }
});

test("identity and os-redis are never on os_core", () => {
  assert.ok(!networkNames(coreConfig.services.identity).includes("os_core"));
  assert.ok(!networkNames(coreConfig.services["os-redis"]).includes("os_core"));
});

test("the README's stop command renders: every image tag it needs is set, with and without the core profile", () => {
  const readme = readFileSync(path.join(root, "deploy", "README.md"), "utf8");
  const line = readme
    .split("\n")
    .find((l) => l.includes("docker compose -p asafarim-os") && l.trim().endsWith(" down"));
  assert.ok(line, "the Rollback section's `down` command was not found");
  const vars = Object.fromEntries([...line.matchAll(/\b([A-Z_]+)=(\S+)/g)].map((m) => [m[1], m[2]]));
  for (const profiles of [vars.COMPOSE_PROFILES ?? "", ""]) {
    const r = render({
      IMAGE_TAG: "",
      SITE_IMAGE_TAG: "",
      DOCS_IMAGE_TAG: "",
      CORE_API_IMAGE_TAG: "",
      ...vars,
      COMPOSE_PROFILES: profiles,
    });
    assert.equal(r.status, 0, `profiles '${profiles}': ${r.stderr}`);
  }
});
