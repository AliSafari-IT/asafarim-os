// `pnpm dev:app` (#104): an image-installed app run in the local OS. Docker, the CLI and core-api are fakes.
//   node --test scripts/dev/dev-app.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  APP_LABEL,
  DEV_NETWORK,
  DevAppError,
  MANIFEST_LABEL,
  containerDatabaseUrl,
  devApp,
  devAppDown,
  parseArgs,
  redact,
  runArgs,
  workerImage,
} from "./dev-app.mjs";

const FIXTURE = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, "../../tools/platform-cli/fixtures/external-app/platform.app.json"),
    "utf8",
  ),
);
const REF = "ghcr.io/example/ext-demo:1.0.0";
const SECRET = "s3cr3t-value-never-printed";
const CREDENTIAL = "osk1.ext-demo.abcdef012345.KEYKEYKEY";
const DB_URL = "postgres://app_ext_demo:dbpassw0rd-xyz@127.0.0.1:55440/app_ext_demo";

let root;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "dev-app-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A fake world: docker (images by ref, containers by label), the platform CLI, core-api's app state. */
function world({ manifest = FIXTURE, state = null, local = true, pullable = false, runFails = false, secrets } = {}) {
  const devDir = path.join(root, ".dev");
  mkdirSync(path.join(devDir, "apps"), { recursive: true });
  if (secrets !== undefined) writeFileSync(path.join(devDir, "apps", `${manifest.id}.secrets.env`), secrets);
  const calls = { docker: [], platform: [], upstream: [], out: [] };
  const containers = new Set();
  const images = new Set(local ? [REF] : []);
  const labels = JSON.stringify({ [MANIFEST_LABEL]: JSON.stringify(manifest) });
  const res = (status, stdout = "", stderr = "") => ({ status, stdout, stderr });
  const deps = {
    devDir,
    root,
    log: (l) => calls.out.push(l),
    coreApiReady: async () => true,
    appState: async () => state,
    setUpstream: (id, port) => calls.upstream.push([id, port]),
    platform: (args) => {
      calls.platform.push(args);
      if (args[1] === "install") {
        writeFileSync(
          path.join(root, args[args.indexOf("--env-out") + 1]),
          `ASAFARIM_APP_ID=${manifest.id}\nASAFARIM_REGISTRY_CREDENTIAL=${CREDENTIAL}\nDATABASE_URL=${DB_URL}\n`,
        );
        state = "installed";
        return {
          ok: true,
          output: `ext-demo installed. Credential and DATABASE_URL written to .dev/apps/ext-demo.env`,
        };
      }
      if (args[1] === "activate") state = "active";
      return { ok: true, output: "ok" };
    },
    docker: (args, env) => {
      calls.docker.push({ args, env });
      if (args[0] === "network") return res(0, "[]");
      if (args[0] === "image") return images.has(args.at(-1)) ? res(0, labels) : res(1, "", "No such image");
      if (args[0] === "pull") {
        if (!pullable) return res(1, "", "Error response from daemon: denied: requires authentication");
        images.add(args.at(-1));
        return res(0);
      }
      if (args[0] === "ps") return res(0, [...containers].join("\n"));
      if (args[0] === "rm") {
        for (const c of args.slice(2)) containers.delete(c);
        return res(0);
      }
      if (args[0] === "run") {
        // A failing docker run that echoes its environment must still not leak it.
        if (runFails) return res(125, "", `Error: bad env ${Object.values(env ?? {}).join(" ")}`);
        containers.add(args[args.indexOf("--name") + 1]);
        return res(0, "abc123\n");
      }
      return res(2, "", "unexpected docker call");
    },
  };
  return { deps, calls, containers, devDir };
}

const runs = (calls) => calls.docker.filter((c) => c.args[0] === "run");

test("a missing secret stops the run before anything is installed or any container starts", async () => {
  const { deps, calls } = world({ secrets: "OTHER=1\n" });
  await assert.rejects(devApp({ ref: REF }, deps), (err) => {
    assert.ok(err instanceof DevAppError);
    assert.match(err.message, /EXT_DEMO_API_KEY/);
    assert.match(err.message, /\.dev\/apps\/ext-demo\.secrets\.env/);
    return true;
  });
  assert.equal(runs(calls).length, 0);
  assert.deepEqual(calls.platform, []);
});

test("no secrets file at all: the declared names are listed, nothing runs", async () => {
  const { deps, calls } = world();
  await assert.rejects(devApp({ ref: REF }, deps), /1 secret\(s\).*EXT_DEMO_API_KEY/);
  assert.equal(runs(calls).length, 0);
});

test("--secrets naming a missing file stops before anything", async () => {
  const { deps, calls } = world({ secrets: `EXT_DEMO_API_KEY=${SECRET}\n` });
  await assert.rejects(devApp({ ref: REF, secretsFile: "nope.env" }, deps), /no such file/);
  assert.equal(runs(calls).length, 0);
  assert.deepEqual(calls.platform, []);
});

test("first run: installs with --env-out (mode 600), runs web + worker hardened, sets the upstream, activates", async () => {
  const { deps, calls, containers, devDir } = world({ secrets: `EXT_DEMO_API_KEY=${SECRET}\n` });
  const r = await devApp({ ref: REF }, deps);
  assert.equal(r.id, "ext-demo");
  assert.deepEqual(calls.platform[0], ["app", "install", "--image", REF, "--env-out", ".dev/apps/ext-demo.env"]);
  assert.deepEqual(calls.platform[1], ["app", "activate", "ext-demo"]);
  assert.equal(statSync(path.join(devDir, "apps", "ext-demo.env")).mode & 0o777, 0o600);
  assert.deepEqual([...containers].sort(), ["asafarim-os-app-ext-demo", "asafarim-os-app-ext-demo-jobs"]);
  assert.deepEqual(calls.upstream, [["ext-demo", FIXTURE.runtime.port]]);

  const [web, worker] = runs(calls);
  for (const { args } of [web, worker]) {
    assert.ok(args.includes("--read-only"));
    assert.deepEqual(args.slice(args.indexOf("--cap-drop"), args.indexOf("--cap-drop") + 2), ["--cap-drop", "ALL"]);
    assert.ok(args.includes(`${APP_LABEL}=ext-demo`));
    assert.equal(args[args.indexOf("--network") + 1], DEV_NETWORK);
    assert.equal(args[args.indexOf("--memory") + 1], "32m");
  }
  const port = FIXTURE.runtime.port;
  assert.equal(web.args[web.args.indexOf("-p") + 1], `127.0.0.1:${port}:${port}`);
  assert.equal(worker.args.indexOf("-p"), -1, "a worker publishes no port");
  // The values go through docker's environment; the database is the compose network's Postgres.
  assert.equal(web.env.EXT_DEMO_API_KEY, SECRET);
  assert.equal(web.env.ASAFARIM_REGISTRY_CREDENTIAL, CREDENTIAL);
  assert.equal(web.env.DATABASE_URL, "postgres://app_ext_demo:dbpassw0rd-xyz@postgres:5432/app_ext_demo");
  assert.equal(web.env.CORE_API_URL, "http://host.docker.internal:4020");
});

test("re-running is a no-op install: the saved env file is reused, nothing is installed or re-activated", async () => {
  const first = world({ secrets: `EXT_DEMO_API_KEY=${SECRET}\n` });
  await devApp({ ref: REF }, first.deps);
  const again = world({ state: "active" }); // same root, same .dev/ files
  const r = await devApp({ ref: REF }, again.deps);
  assert.equal(r.id, "ext-demo");
  assert.deepEqual(again.calls.platform, []);
  assert.equal(runs(again.calls).length, 2);
  assert.match(again.calls.out.join("\n"), /already installed \(active\); reusing \.dev\/apps\/ext-demo\.env/);
});

test("installed in core-api but the credential file is gone: stop and say how to recover", async () => {
  const { deps, calls } = world({ state: "active", secrets: `EXT_DEMO_API_KEY=${SECRET}\n` });
  await assert.rejects(devApp({ ref: REF }, deps), /pnpm dev:reset/);
  assert.equal(runs(calls).length, 0);
});

test("secret values, the credential and DATABASE_URL never appear in the output or the docker command line", async () => {
  const ok = world({ secrets: `EXT_DEMO_API_KEY=${SECRET}\n` });
  await devApp({ ref: REF }, ok.deps);
  const failing = world({ secrets: `EXT_DEMO_API_KEY=${SECRET}\n`, runFails: true });
  let message = "";
  await devApp({ ref: REF }, failing.deps).catch((err) => (message = err.message));
  assert.match(message, /docker run asafarim-os-app-ext-demo/);
  const printed = [...ok.calls.out, ...failing.calls.out, message].join("\n");
  const argv = [...ok.calls.docker, ...failing.calls.docker].map((c) => c.args.join(" ")).join("\n");
  for (const value of [SECRET, CREDENTIAL, DB_URL, "dbpassw0rd-xyz", "@postgres:5432"]) {
    assert.ok(!printed.includes(value), `output leaks ${value}`);
    assert.ok(!argv.includes(value), `docker argv leaks ${value}`);
  }
  assert.equal(failing.containers.size, 0, "a failed start leaves no containers behind");
});

test("needs a running pnpm dev", async () => {
  const { deps, calls } = world({ secrets: `EXT_DEMO_API_KEY=${SECRET}\n` });
  deps.coreApiReady = async () => false;
  await assert.rejects(devApp({ ref: REF }, deps), /pnpm dev/);
  assert.equal(calls.docker.length, 0);
});

test("an image that isn't local is pulled; one that can't be pulled reports docker pull failing", async () => {
  const pulled = world({ local: false, pullable: true, secrets: `EXT_DEMO_API_KEY=${SECRET}\n` });
  await devApp({ ref: REF }, pulled.deps);
  assert.ok(pulled.calls.docker.some((c) => c.args[0] === "pull"));

  const denied = world({ local: false, secrets: `EXT_DEMO_API_KEY=${SECRET}\n` });
  await assert.rejects(devApp({ ref: REF }, denied.deps), /docker pull ghcr\.io\/example\/ext-demo:1\.0\.0 failed/);
  assert.deepEqual(denied.calls.platform, []);
});

test("--down removes the app's containers and nothing else", async () => {
  const { deps, calls, containers } = world({ secrets: `EXT_DEMO_API_KEY=${SECRET}\n` });
  await devApp({ ref: REF }, deps);
  calls.platform.length = 0;
  assert.equal(devAppDown("ext-demo", deps), 2);
  assert.equal(containers.size, 0);
  assert.deepEqual(calls.platform, [], "no uninstall, no deactivate");
  assert.ok(existsSync(path.join(root, ".dev/apps/ext-demo.env")), "the install's env file stays");
});

test("worker images: same image, derived from the installed reference, or as declared", () => {
  const m = { runtime: { image: "igs-pharma-web" } };
  const ref = "ghcr.io/alisafari-it/igs-pharma-web:abc123";
  assert.equal(workerImage(ref, m, { image: "igs-pharma-web" }), ref);
  assert.equal(workerImage(ref, m, { image: "igs-pharma-worker" }), "ghcr.io/alisafari-it/igs-pharma-worker:abc123");
  assert.equal(workerImage(ref, m, { image: "igs-pharma-worker:v2" }), "ghcr.io/alisafari-it/igs-pharma-worker:v2");
  assert.equal(workerImage("other/thing:1", m, { image: "igs-pharma-worker" }), "igs-pharma-worker");
  assert.equal(
    workerImage(`ghcr.io/a/igs-pharma-web@sha256:${"a".repeat(64)}`, m, { image: "igs-pharma-worker" }),
    "igs-pharma-worker",
  );
});

test("runArgs carries names only, binds the port to 127.0.0.1", () => {
  const args = runArgs({
    id: "x-app",
    name: "n",
    image: "i",
    envNames: ["A", "B"],
    resources: { memory: "64m", cpus: 0.5 },
    port: 3000,
    hostPort: 4300,
  });
  assert.deepEqual(args.slice(args.indexOf("-e"), args.indexOf("-e") + 4), ["-e", "A", "-e", "B"]);
  assert.equal(args[args.indexOf("-p") + 1], "127.0.0.1:4300:3000");
  assert.equal(args.at(-1), "i");
});

test("containerDatabaseUrl only rewrites the dev Postgres", () => {
  assert.equal(containerDatabaseUrl("postgres://u:p@127.0.0.1:55440/db"), "postgres://u:p@postgres:5432/db");
  assert.equal(containerDatabaseUrl("postgres://u:p@db.example:5432/db"), "postgres://u:p@db.example:5432/db");
});

test("parseArgs", () => {
  assert.deepEqual(parseArgs([REF]), { down: false, ref: REF });
  assert.deepEqual(parseArgs([REF, "--secrets", "s.env", "--port", "4300"]), {
    down: false,
    ref: REF,
    secretsFile: "s.env",
    port: 4300,
  });
  assert.deepEqual(parseArgs(["ext-demo", "--down"]), { down: true, id: "ext-demo" });
  assert.ok(parseArgs([]).error);
  assert.ok(parseArgs(["--rm"]).error);
  assert.ok(parseArgs(["-v/:/host"]).error);
  assert.ok(parseArgs(["Bad:Ref!"]).error);
  assert.ok(parseArgs([REF, "--port", "80"]).error);
  assert.ok(parseArgs(["ext-demo", "--down", "--port", "4300"]).error);
});

test("redact masks every value, longest first", () => {
  assert.equal(redact("a=abcdef b=abcdefgh", ["abcdef", "abcdefgh"]), "a=*** b=***");
  assert.equal(redact("short ab", ["ab"]), "short ab", "values under 4 characters are left alone");
});
