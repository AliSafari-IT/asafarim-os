// deploy/vps-deploy.sh and its env checker (asafarim-os#45). The script itself needs the VPS (docker, age, the
// edge), so what is tested here is what can be: the check that decides whether secrets are filled in, and the
// SHAPE of the script (its order, and that it can never print a secret).
//
//   node --test deploy/vps-deploy.test.mjs          (needs bash)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(path.join(root, "deploy", "vps-deploy.sh"), "utf8");
// The same text without comment-only lines: the header comment names every step, so searching it finds the wrong place.
const code = script
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");
const realExample = path.join(root, "core", "identity", ".env.production.example");

/** Run require_env_vars on two fixture files; returns { status, output } with stdout and stderr together. */
function check(envText, exampleText) {
  const dir = mkdtempSync(path.join(tmpdir(), "env-check-"));
  try {
    writeFileSync(path.join(dir, "env"), envText);
    writeFileSync(path.join(dir, "example"), exampleText);
    const run = spawnSync(
      "bash",
      [path.join(root, "deploy/test-fixtures/run-env-check.sh"), path.join(dir, "env"), path.join(dir, "example")],
      { encoding: "utf8" },
    );
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const EXAMPLE = "# a comment, and a commented variable:\n# NOT_REQUIRED=\nA_ONE=\nB_TWO=\nC_THREE=\n";

test("all variables set: passes, and prints nothing", () => {
  const result = check("A_ONE=a\nB_TWO=b\nC_THREE=c\n", EXAMPLE);
  assert.equal(result.status, 0);
  assert.equal(result.output, "");
});

test("a missing, an empty and a quotes-only variable are all reported, by NAME", () => {
  const result = check('A_ONE=\nB_TWO=""\n', EXAMPLE); // A_ONE empty, B_TWO quotes only, C_THREE absent
  assert.equal(result.status, 1);
  assert.match(result.output, /A_ONE/);
  assert.match(result.output, /B_TWO/);
  assert.match(result.output, /C_THREE/);
});

test("a failure never prints a value, even the value of another variable in the same file", () => {
  const secret = "s3cr3t-value-that-must-not-leak";
  const result = check(`A_ONE=${secret}\nB_TWO=\nC_THREE='${secret}-2'\n`, EXAMPLE);
  assert.equal(result.status, 1);
  assert.match(result.output, /B_TWO/);
  assert.doesNotMatch(result.output, /s3cr3t/);
});

test("a commented variable in the example is not required", () => {
  const result = check("A_ONE=a\nB_TWO=b\nC_THREE=c\n", EXAMPLE);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.output, /NOT_REQUIRED/);
});

test("values may hold =, braces and quotes (JSON keys), and CRLF line endings are tolerated", () => {
  const result = check('A_ONE={"keys":[{"kty":"EC","d":"abc=="}]}\r\nB_TWO=x=y=z\r\nC_THREE=c\r\n', EXAMPLE);
  assert.equal(result.status, 0, result.output);
});

test("the last assignment wins, as in a dotenv file", () => {
  assert.equal(check("A_ONE=\nA_ONE=a\nB_TWO=b\nC_THREE=c\n", EXAMPLE).status, 0);
  const lastEmpty = check("A_ONE=a\nA_ONE=\nB_TWO=b\nC_THREE=c\n", EXAMPLE);
  assert.equal(lastEmpty.status, 1);
  assert.match(lastEmpty.output, /A_ONE/);
});

test("a variable name that is only a prefix of another does not count as set", () => {
  const result = check("A_ONE_EXTRA=x\nB_TWO=b\nC_THREE=c\n", EXAMPLE);
  assert.equal(result.status, 1);
  assert.match(result.output, /A_ONE/);
});

test("the real example lists the five required variables, and a filled file passes", () => {
  const names = readFileSync(realExample, "utf8").match(/^[A-Z][A-Z0-9_]*(?==)/gm);
  assert.deepEqual(names, [
    "IDENTITY_ACCOUNTS_DATABASE_URL",
    "IDENTITY_OIDC_JWKS",
    "IDENTITY_COOKIE_KEYS",
    "IDENTITY_HANDOFF_PRIVATE_JWK",
    "IDENTITY_HUB_PUBLIC_JWK",
  ]);
  const filled = names.map((n) => `${n}=dummy-${n}`).join("\n") + "\n";
  const dir = mkdtempSync(path.join(tmpdir(), "env-check-"));
  try {
    writeFileSync(path.join(dir, "env"), filled);
    const run = spawnSync(
      "bash",
      [path.join(root, "deploy/test-fixtures/run-env-check.sh"), path.join(dir, "env"), realExample],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the script is valid bash", () => {
  for (const file of ["deploy/vps-deploy.sh", "deploy/lib/env-check.sh"]) {
    const run = spawnSync("bash", ["-n", path.join(root, file)], { encoding: "utf8" });
    assert.equal(run.status, 0, `${file}: ${run.stderr}`);
  }
});

test("the steps run in order: reset, decrypt, env check, networks, pull, up, readyz, publish the site", () => {
  const at = (needle) => {
    const i = code.indexOf(needle);
    assert.ok(i >= 0, `vps-deploy.sh must contain: ${needle}`);
    return i;
  };
  const order = [
    "git reset --hard",
    "age -d -i .age/key.txt core/identity/.env.production.age",
    "require_env_vars .env.identity core/identity/.env.production.example",
    "docker network inspect identity_db",
    '"${compose[@]}" pull',
    '"${compose[@]}" up -d',
    "/readyz",
    'edge-deploy-site.sh" asafarim-os',
  ].map(at);
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    "the steps are out of order",
  );
});

test("the site is published only after os-site is ready too (#70)", () => {
  const ready = code.indexOf('if [[ "$site_ready" != true ]]');
  const publish = code.indexOf('edge-deploy-site.sh" asafarim-os');
  assert.ok(ready > 0 && publish > ready);
  assert.match(code.slice(ready, publish), /fatal /, "a not-ready os-site must stop the script before publishing");
  assert.match(code, /exec -T os-site wget -qO- http:\/\/127\.0\.0\.1:8080\/healthz/);
});

test("the site image tag is a third, optional sha, checked like the others and exported for compose (#70)", () => {
  assert.match(code, /local site_image_commit="\$\{3:-\$commit\}"/);
  assert.match(script, /\[\[ "\$site_image_commit" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(code, /export SITE_IMAGE_TAG="\$site_image_commit"/);
  assert.ok(code.indexOf("export SITE_IMAGE_TAG") < code.indexOf('"${compose[@]}" config -q'));
});

test("the site is published only after identity is ready", () => {
  const ready = code.indexOf('if [[ "$ready" != true ]]');
  const publish = code.indexOf('edge-deploy-site.sh" asafarim-os');
  assert.ok(ready > 0 && publish > ready);
  assert.match(code.slice(ready, publish), /fatal /, "a not-ready identity must stop the script before publishing");
});

test("it decrypts into a private file and sets mode 600", () => {
  assert.match(script, /umask 077/);
  assert.match(script, /chmod 600 \.env\.identity/);
});

test("it can never print a secret: no set -x, no source/cat of the env, and `compose config` only with -q", () => {
  assert.doesNotMatch(code, /set -[a-z]*x/, "set -x would print every command, and its variables");
  assert.doesNotMatch(code, /\b(source|\.)\s+\S*\.env\.identity/, "never source the secrets");
  assert.doesNotMatch(code, /\b(cat|less|head|tail|echo|printf)\b[^\n]*\.env\.identity/, "never print the secrets");
  // `docker compose config` inlines env_file values into its output: only the quiet form is allowed.
  for (const m of code.matchAll(/"\$\{compose\[@\]\}" config([^\n]*)/g)) {
    assert.match(m[1], /^ -q\b/, "compose config without -q would print the secrets");
  }
  assert.doesNotMatch(
    code,
    /logs[^\n]*\|\s*(cat|tee)|compose\[@\]\}" logs/,
    "it must not dump container logs on its own",
  );
});

test("it refuses a commit that is not a full sha or not on origin/main, and runs main() on one last line", () => {
  assert.match(script, /\[\[ "\$commit" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(script, /git merge-base --is-ancestor "\$commit" origin\/main/);
  assert.equal(script.trimEnd().split("\n").at(-1), 'main "$@"; exit $?');
});

// #97: run the real script against stand-ins for git, docker, age, flock and the edge's edge-deploy-site.sh, in a
// throwaway copy of the files it reads. Each stand-in logs its arguments, so the tests see exactly what a deploy
// would run, and a mode that must not read a file is run without that file.
const SHA = "a".repeat(40);
const SITE_SHA = "b".repeat(40);
const STUB = (name, body = "") => `#!/usr/bin/env bash\necho "${name} $*" >> "$CALLS"\n${body}\n`;

/**
 * `live`: the Caddy that serves 443 before the edge cutover (asafarim-com's). `null` means none runs.
 * `edgeId`: the edge container's id after the cutover ("" = none). `prevLive`: a file already in its sites.local/.
 */
function runDeploy(
  args,
  {
    full = false,
    identityRunning = "",
    live = { id: "live0caddy01", networks: "asafarim-com_default edge_net", validate: 0, reload: 0 },
    edgeId = "",
    prevLive = null,
  } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "vps-deploy-"));
  const repo = path.join(dir, "repo");
  const bin = path.join(dir, "bin");
  const edge = path.join(dir, "edge");
  const calls = path.join(dir, "calls.log");
  const liveRepo = path.join(dir, "asafarim-com");
  const liveSite = path.join(liveRepo, "infra/caddy/sites.local/asafarim-os.caddy");
  try {
    for (const file of [
      "deploy/vps-deploy.sh",
      "deploy/lib/env-check.sh",
      "deploy/lib/live-caddy.sh",
      "deploy/compose.prod.yml",
      "sites/asafarim-os.caddy",
      "sites/asafarim-os-site.caddy",
      "core/identity/.env.production.example",
    ]) {
      cpSync(path.join(root, file), path.join(repo, file), { recursive: true });
    }
    if (full) {
      mkdirSync(path.join(repo, ".age"));
      writeFileSync(path.join(repo, ".age", "key.txt"), "stand-in key\n");
      writeFileSync(path.join(repo, "core/identity/.env.production.age"), "stand-in ciphertext\n");
      mkdirSync(path.join(repo, "deploy/identity"));
      writeFileSync(path.join(repo, "deploy/identity/clients.json"), "{}\n");
    }
    const filled = readFileSync(realExample, "utf8")
      .match(/^[A-Z][A-Z0-9_]*(?==)/gm)
      .map((n) => `echo ${n}=stand-in`)
      .join("\n");
    mkdirSync(bin);
    const stubs = {
      git: STUB("git"),
      flock: STUB("flock"),
      age: STUB("age", filled),
      docker: STUB(
        "docker",
        [
          `case "$*" in`,
          `  *"ps -q identity"*) printf '%s' "$IDENTITY_RUNNING" ;;`,
          `  "ps -q --filter label=com.docker.compose.project=asafarim-com"*) printf '%s\\n' "$LIVE_ID" ;;`,
          `  "compose -p edge ps -q caddy") printf '%s\\n' "$EDGE_ID" ;;`,
          `  "inspect -f {{range"*) echo "$LIVE_NETWORKS" ;;`,
          `  "inspect -f {{.Config.Image}}"*) echo caddy:live ;;`,
          `  "run --rm -v "*"caddy validate"*) exit "$LIVE_VALIDATE" ;;`,
          `  "exec $LIVE_ID caddy reload"*) exit "$LIVE_RELOAD" ;;`,
          `  "exec $LIVE_ID sha256sum "*) sha256sum "$LIVE_REPO_DIR/infra/caddy/sites.local/asafarim-os.caddy" ;;`,
          `esac`,
          `exit 0`,
        ].join("\n"),
      ),
    };
    for (const [name, body] of Object.entries(stubs)) writeFileSync(path.join(bin, name), body, { mode: 0o755 });
    mkdirSync(path.join(edge, "scripts"), { recursive: true });
    writeFileSync(path.join(edge, "scripts", "edge-deploy-site.sh"), STUB("edge-deploy-site.sh"));
    writeFileSync(calls, "");
    mkdirSync(path.dirname(liveSite), { recursive: true });
    writeFileSync(path.join(liveRepo, "infra/caddy/Caddyfile"), "import sites.local/*.caddy\n");
    if (prevLive !== null) writeFileSync(liveSite, prevLive);
    const run = spawnSync("bash", [path.join(repo, "deploy/vps-deploy.sh"), ...args], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        CALLS: calls,
        EDGE_DIR: edge,
        IDENTITY_RUNNING: identityRunning,
        LIVE_REPO_DIR: liveRepo,
        LIVE_ID: live?.id ?? "",
        LIVE_NETWORKS: live?.networks ?? "",
        LIVE_VALIDATE: String(live?.validate ?? 0),
        LIVE_RELOAD: String(live?.reload ?? 0),
        EDGE_ID: edgeId,
      },
    });
    return {
      status: run.status,
      stderr: run.stderr,
      calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
      envIdentityWritten: existsSync(path.join(repo, ".env.identity")),
      liveSite: existsSync(liveSite) ? readFileSync(liveSite, "utf8") : null,
      repo,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const compose = "docker compose -p asafarim-os -f deploy/compose.prod.yml";

test("--site-only: never decrypts, never checks identity_db or clients.json, starts only os-site, publishes the site-only file", () => {
  const r = runDeploy(["--site-only", SHA, SITE_SHA]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.some((c) => c.startsWith("age ")), "age must not run");
  assert.equal(r.envIdentityWritten, false, ".env.identity must not be written");
  assert.ok(!r.calls.some((c) => c.includes("identity_db")), "identity_db must not be checked");
  assert.ok(r.calls.includes("docker network inspect edge_net"));
  assert.ok(r.calls.includes("git reset --hard " + SHA));
  const composeCalls = r.calls.filter((c) => c.startsWith(compose)).map((c) => c.slice(compose.length + 1));
  assert.deepEqual(composeCalls, [
    "ps -q identity",
    "config -q --no-env-resolution os-site",
    "pull os-site",
    "up -d --no-deps os-site",
    "exec -T os-site wget -qO- http://127.0.0.1:8080/healthz",
  ]);
  assert.ok(r.calls.includes(`edge-deploy-site.sh asafarim-os ${r.repo}/sites/asafarim-os-site.caddy`));
});

test("--site-only refuses to run while identity is running, and changes nothing", () => {
  const r = runDeploy(["--site-only", SHA], { identityRunning: "0123456789ab" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /identity is running/);
  assert.ok(!r.calls.some((c) => / (pull|up) /.test(c) || c.startsWith("edge-deploy-site.sh")), r.calls.join("\n"));
  assert.equal(r.liveSite, null);
});

test("--site-only takes at most two shas, each a full sha", () => {
  assert.match(runDeploy(["--site-only", SHA, SITE_SHA, SHA]).stderr, /usage:/);
  assert.match(runDeploy(["--site-only", SHA, "abc"]).stderr, /<site-image-commit> must be a full 40-character sha/);
  assert.match(runDeploy(["--site-only"]).stderr, /usage:/);
});

test("full mode still decrypts, checks, starts the whole stack, waits for both and publishes the full site file", () => {
  const r = runDeploy([SHA, SHA, SITE_SHA], { full: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.includes("age -d -i .age/key.txt core/identity/.env.production.age"));
  assert.ok(r.calls.includes("docker network inspect identity_db"));
  const composeCalls = r.calls.filter((c) => c.startsWith(compose)).map((c) => c.slice(compose.length + 1));
  assert.deepEqual(composeCalls, [
    "config -q",
    "pull",
    "up -d --remove-orphans",
    "exec -T identity wget -qO- http://127.0.0.1:3000/readyz",
    "exec -T os-site wget -qO- http://127.0.0.1:8080/healthz",
  ]);
  assert.equal(r.calls.at(-1), `edge-deploy-site.sh asafarim-os ${r.repo}/sites/asafarim-os.caddy`);
  assert.ok(
    !r.calls.some((c) => c.includes("asafarim-com") || c.includes("caddy reload")),
    "full mode never touches the live Caddy",
  );
  assert.equal(r.liveSite, null);
});

// Before the edge cutover the edge only stores the file: the Caddy that serves 443 is asafarim-com's.
const siteOnlyFile = readFileSync(path.join(root, "sites", "asafarim-os-site.caddy"), "utf8");

test("--site-only, before the cutover: after the edge, validates and installs the file for the live Caddy, reloads it", () => {
  const r = runDeploy(["--site-only", SHA]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.liveSite, siteOnlyFile, "sites.local/asafarim-os.caddy is the site-only file");
  const edgeAt = r.calls.findIndex((c) => c.startsWith("edge-deploy-site.sh"));
  const validateAt = r.calls.findIndex(
    (c) => c.startsWith("docker run --rm -v ") && c.includes("caddy:live caddy validate"),
  );
  const reloadAt = r.calls.indexOf(
    "docker exec live0caddy01 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile",
  );
  assert.ok(edgeAt >= 0 && validateAt > edgeAt && reloadAt > validateAt, r.calls.join("\n"));
});

test("--site-only: a live config that refuses the file (asafarim.site still defined there) leaves the live Caddy untouched", () => {
  const r = runDeploy(["--site-only", SHA], {
    live: { id: "live0caddy01", networks: "edge_net", validate: 1, reload: 0 },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid with the live Caddy config/);
  assert.equal(r.liveSite, null);
  assert.ok(!r.calls.some((c) => c.includes("caddy reload")));
});

test("--site-only: a failed reload puts the previous live file back", () => {
  const r = runDeploy(["--site-only", SHA], {
    live: { id: "live0caddy01", networks: "edge_net", validate: 0, reload: 1 },
    prevLive: "# the previous file\n",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /caddy reload failed; restoring/);
  assert.equal(r.liveSite, "# the previous file\n");
});

test("--site-only: a live Caddy that is not on edge_net is refused, with the one command that fixes it", () => {
  const r = runDeploy(["--site-only", SHA], { live: { id: "live0caddy01", networks: "asafarim-com_default" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /docker network connect edge_net live0caddy01/);
  assert.equal(r.liveSite, null);
});

test("--site-only after the cutover (an edge container, no asafarim-com Caddy): the edge publish is enough", () => {
  const r = runDeploy(["--site-only", SHA], { live: null, edgeId: "edge0caddy01" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.liveSite, null);
  assert.ok(!r.calls.some((c) => c.includes("caddy reload")));
});

test("--site-only with neither Caddy running fails: nothing serves 443", () => {
  const r = runDeploy(["--site-only", SHA], { live: null, edgeId: "" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nothing serves 443/);
});
