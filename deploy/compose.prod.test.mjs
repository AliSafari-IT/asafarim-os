// The production stack's compose file and site file (asafarim-os#45). Compose parses the file, not a regex:
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

/**
 * Render the compose file in a throwaway copy of the layout it expects: deploy/compose.prod.yml, and an EMPTY
 * ../.env.identity (Compose refuses a missing env_file, and the real one holds secrets: never read or print it).
 */
function render(env = { IMAGE_TAG: "testsha" }) {
  const dir = mkdtempSync(path.join(tmpdir(), "compose-prod-"));
  try {
    mkdirSync(path.join(dir, "deploy"));
    cpSync(path.join(root, "deploy", "compose.prod.yml"), path.join(dir, "deploy", "compose.prod.yml"));
    writeFileSync(path.join(dir, ".env.identity"), "");
    const run = spawnSync("docker", ["compose", "-f", "compose.prod.yml", "config", "--format", "json"], {
      cwd: path.join(dir, "deploy"),
      env: { ...process.env, IMAGE_TAG: "", ...env },
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
const { identity, "os-redis": redis } = config.services;
const networkNames = (service) => Object.keys(service.networks ?? {}).sort();

test("the file renders as the asafarim-os project with exactly identity and os-redis", () => {
  assert.equal(config.name, "asafarim-os");
  assert.deepEqual(Object.keys(config.services).sort(), ["identity", "os-redis"]);
});

test("the image tag comes from IMAGE_TAG, and there is no default", () => {
  assert.equal(identity.image, "ghcr.io/alisafari-it/asafarim-os:identity-testsha");
  const unset = render({ IMAGE_TAG: "" });
  assert.notEqual(unset.status, 0, "a deploy without IMAGE_TAG must fail, not pull identity-");
  assert.match(unset.stderr, /IMAGE_TAG/);
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

test("the site file serves only id.asafarim.site, and proxies to the alias the compose file declares", () => {
  const sites = [...siteText.matchAll(/^([a-z0-9.*-]+)(?:, [a-z0-9.*-]+)*\s*\{/gm)].map((m) => m[1]);
  assert.deepEqual(sites, ["id.asafarim.site"]);
  const upstream = /reverse_proxy ([\w-]+):(\d+)/.exec(siteText);
  assert.ok(upstream, "the site must reverse_proxy to identity");
  assert.ok(
    identity.networks.edge_net.aliases.includes(upstream[1]),
    `the site proxies to ${upstream[1]}, which is not identity's edge_net alias`,
  );
  assert.equal(upstream[2], "3000");
});

test("the site file has no Content-Security-Policy of its own (identity sets a strict one per page)", () => {
  const active = siteText
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(active, /Content-Security-Policy/i);
  assert.match(active, /Strict-Transport-Security/);
  assert.match(active, /X-Content-Type-Options nosniff/);
});
