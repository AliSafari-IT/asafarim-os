// The production stack's compose file and site file (asafarim-os#45; os-site and asafarim.site: #70). Compose parses the file, not a regex:
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
const activeSite = siteText
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");

/** One top-level block of the site file, by its exact site address (comments removed). */
function siteBlock(address) {
  const start = activeSite.search(new RegExp(`^${address.replaceAll(".", "\\.")} \\{`, "m"));
  assert.ok(start >= 0, `the site file has no ${address} block`);
  const end = activeSite.indexOf("\n}", start);
  return activeSite.slice(start, end + 2);
}

/**
 * Render the compose file in a throwaway copy of the layout it expects: deploy/compose.prod.yml, and an EMPTY
 * ../.env.identity (Compose refuses a missing env_file, and the real one holds secrets: never read or print it).
 */
function render(env = { IMAGE_TAG: "testsha", SITE_IMAGE_TAG: "sitesha" }) {
  const dir = mkdtempSync(path.join(tmpdir(), "compose-prod-"));
  try {
    mkdirSync(path.join(dir, "deploy"));
    cpSync(path.join(root, "deploy", "compose.prod.yml"), path.join(dir, "deploy", "compose.prod.yml"));
    writeFileSync(path.join(dir, ".env.identity"), "");
    const run = spawnSync("docker", ["compose", "-f", "compose.prod.yml", "config", "--format", "json"], {
      cwd: path.join(dir, "deploy"),
      env: { ...process.env, IMAGE_TAG: "", SITE_IMAGE_TAG: "", ...env },
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
const { identity, "os-redis": redis, "os-site": site } = config.services;
const networkNames = (service) => Object.keys(service.networks ?? {}).sort();

test("the file renders as the asafarim-os project with exactly identity, os-redis and os-site", () => {
  assert.equal(config.name, "asafarim-os");
  assert.deepEqual(Object.keys(config.services).sort(), ["identity", "os-redis", "os-site"]);
});

test("the image tag comes from IMAGE_TAG, and there is no default", () => {
  assert.equal(identity.image, "ghcr.io/alisafari-it/asafarim-os:identity-testsha");
  const unset = render({ IMAGE_TAG: "", SITE_IMAGE_TAG: "sitesha" });
  assert.notEqual(unset.status, 0, "a deploy without IMAGE_TAG must fail, not pull identity-");
  assert.match(unset.stderr, /IMAGE_TAG/);
});

test("os-site's image tag comes from SITE_IMAGE_TAG, and there is no default", () => {
  assert.equal(site.image, "ghcr.io/alisafari-it/asafarim-os:site-sitesha");
  const unset = render({ IMAGE_TAG: "testsha", SITE_IMAGE_TAG: "" });
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

test("os-redis is on os_net ONLY: never on edge_net or identity_db", () => {
  assert.deepEqual(networkNames(redis), ["os_net"]);
});

test("nothing publishes a port", () => {
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

test("the site file serves id.asafarim.site, asafarim.site and its www redirect, nothing else", () => {
  const sites = [...activeSite.matchAll(/^([a-z0-9.*-]+)(?:, [a-z0-9.*-]+)*\s*\{/gm)].map((m) => m[1]);
  assert.deepEqual(sites.sort(), ["asafarim.site", "id.asafarim.site", "www.asafarim.site"]);
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
  for (const directive of ["default-src 'none'", "script-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) {
    assert.ok(csp.split("; ").includes(directive), `the CSP needs ${directive}`);
  }
  assert.doesNotMatch(csp, /https?:|\*|'unsafe-/, "no third-party origins, wildcards or unsafe-* sources");
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

test("id.asafarim.site has no Content-Security-Policy of its own (identity sets a strict one per page)", () => {
  const active = siteBlock("id.asafarim.site");
  assert.doesNotMatch(active, /Content-Security-Policy/i);
  assert.match(active, /Strict-Transport-Security/);
  assert.match(active, /X-Content-Type-Options nosniff/);
});
