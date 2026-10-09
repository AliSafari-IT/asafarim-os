// The dev stack's compose file (P4.1: the event bus). Compose parses the file, not a regex: these tests read
// `docker compose config --format json`, the model Compose itself runs.
//
//   node --test scripts/dev/compose.dev.test.mjs        (needs the docker CLI; no daemon, no network)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEV } from "./keys.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Render compose.dev.yml in a throwaway copy, with an EMPTY .dev/gateway.env and a stand-in .dev/nats.env (Compose refuses a missing env_file). */
function render() {
  const dir = mkdtempSync(path.join(tmpdir(), "compose-dev-"));
  try {
    cpSync(path.join(root, "compose.dev.yml"), path.join(dir, "compose.dev.yml"));
    mkdirSync(path.join(dir, ".dev"));
    writeFileSync(path.join(dir, ".dev", "gateway.env"), "");
    writeFileSync(path.join(dir, ".dev", "nats.env"), "NATS_CORE_PASSWORD=pw\nNATS_AUTH_ISSUER=issuer\n");
    const run = spawnSync("docker", ["compose", "-f", "compose.dev.yml", "config", "--format", "json"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, `docker compose config failed:\n${run.stderr}`);
    return JSON.parse(run.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const config = render();
const nats = config.services.nats;

test("NATS runs with JetStream and its file store on a dev volume", () => {
  assert.ok(nats, "compose.dev.yml has a nats service");
  assert.match(nats.image, /^nats:2(-|$|\.)/);
  assert.ok(nats.command.includes("-js"), "JetStream is enabled (-js)");
  const sd = nats.command.indexOf("-sd");
  assert.ok(sd >= 0, "a store directory is set (-sd)");
  const store = nats.command[sd + 1];
  const mount = nats.volumes.find((v) => v.target === store);
  assert.ok(mount && mount.type === "volume" && mount.source === "nats_data", "the store is the nats_data volume");
  assert.ok(config.volumes.nats_data, "nats_data is declared (pnpm dev:reset drops it with the others)");
});

test("NATS declares its memory and CPU limits", () => {
  assert.ok(nats.mem_limit, "mem_limit is set");
  assert.ok(Number(nats.cpus) > 0, "cpus is set");
});

test("NATS is published on 127.0.0.1 only, on the port the dev keys point at", () => {
  assert.ok(nats.ports.length > 0);
  for (const p of nats.ports) assert.equal(p.host_ip, "127.0.0.1", `port ${p.published} binds to ${p.host_ip}`);
  const client = nats.ports.find((p) => p.target === 4222);
  assert.ok(client, "the client port 4222 is published");
  assert.equal(`nats://127.0.0.1:${client.published}`, DEV.natsUrl);
  assert.ok(!nats.ports.some((p) => p.target === 8222), "the monitoring port stays inside the container");
});

test("NATS has a healthcheck that waits for JetStream (pnpm dev's `up --wait` relies on it)", () => {
  const cmd = nats.healthcheck?.test?.join(" ") ?? "";
  assert.match(cmd, /healthz\?js-enabled-only=true/);
  assert.ok(nats.command.includes("-m"), "the monitoring endpoint the healthcheck reads is enabled");
});

test("NATS checks every client: it runs nats.conf (the auth callout) and reads its two values from .dev/nats.env", () => {
  const c = nats.command;
  const at = c.indexOf("-c");
  assert.ok(at >= 0, "a config file is passed (-c)");
  const conf = c[at + 1];
  assert.match(conf, /nats\.conf$/);
  const dir = path.posix.dirname(conf);
  const mount = nats.volumes.find((v) => v.target === dir);
  assert.ok(mount && mount.type === "bind" && mount.read_only, `${dir} is a read-only bind mount`);
  assert.ok(
    mount.source.endsWith(path.join("scripts", "dev", "nats")),
    `the mount is scripts/dev/nats (a directory, not a file)`,
  );
  assert.deepEqual(
    { password: nats.environment?.NATS_CORE_PASSWORD, issuer: nats.environment?.NATS_AUTH_ISSUER },
    { password: "pw", issuer: "issuer" },
    "the container gets both values from .dev/nats.env",
  );
});

test("nats.conf has no secrets: both values come from the environment, and anonymous clients go to the callout", () => {
  const text = readFileSync(path.join(root, "scripts", "dev", "nats", "nats.conf"), "utf8");
  assert.match(text, /password:\s*\$NATS_CORE_PASSWORD/);
  assert.match(text, /issuer:\s*\$NATS_AUTH_ISSUER/);
  assert.match(text, /auth_users:\s*\[\s*core\s*\]/);
  assert.ok(!/no_auth_user/.test(text), "no anonymous user");
  assert.ok(!/\b[AU][A-Z2-7]{55}\b/.test(text), "no nkey in the file");
});
