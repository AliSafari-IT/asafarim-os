// deploy/vps-deploy.sh and its env checker (asafarim-os#45). The script itself needs the VPS (docker, age, the
// edge), so what is tested here is what can be: the check that decides whether secrets are filled in, and the
// SHAPE of the script (its order, and that it can never print a secret).
//
//   node --test deploy/vps-deploy.test.mjs          (needs bash)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const docsExample = path.join(root, "apps", "docs", ".env.production.example");
const coreApiExample = path.join(root, "core", "core-api", ".env.production.example");
const adminExample = path.join(root, "core", "admin", ".env.production.example");
const flowExample = path.join(root, "apps", "flow", ".env.production.example");

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

/** Run require_identity_env on an env file and the real identity example; returns { status, output }. */
function identityCheck(envText) {
  const dir = mkdtempSync(path.join(tmpdir(), "env-check-"));
  try {
    writeFileSync(path.join(dir, "env"), envText);
    const run = spawnSync(
      "bash",
      [path.join(root, "deploy/test-fixtures/run-identity-env-check.sh"), path.join(dir, "env"), realExample],
      { encoding: "utf8" },
    );
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const env = (names) => names.map((n) => `${n}=stand-in-${n}`).join("\n") + "\n";
const HUB = [
  "IDENTITY_ACCOUNTS_DATABASE_URL",
  "IDENTITY_OIDC_JWKS",
  "IDENTITY_COOKIE_KEYS",
  "IDENTITY_HANDOFF_PRIVATE_JWK",
  "IDENTITY_HUB_PUBLIC_JWK",
];
const LOCAL = ["IDENTITY_OIDC_JWKS", "IDENTITY_COOKIE_KEYS", "IDENTITY_DATABASE_URL", "IDENTITY_OTP_SECRET"];
const SMTP = ["IDENTITY_SMTP_HOST", "IDENTITY_SMTP_FROM"];

test("identity, hub (the default): the example's variables, as before", () => {
  assert.equal(identityCheck(env(HUB)).status, 0);
  assert.equal(identityCheck(`IDENTITY_LOGIN_METHOD=hub\n${env(HUB)}`).status, 0);
  const missing = identityCheck(env(HUB.slice(1)));
  assert.equal(missing.status, 1);
  assert.match(missing.output, /IDENTITY_ACCOUNTS_DATABASE_URL/);
});

test("identity, local (email and passkeys): no Hub variables; its own database, the code secret and SMTP", () => {
  const ok = identityCheck(`IDENTITY_LOGIN_METHOD=local\n${env([...LOCAL, ...SMTP])}`);
  assert.equal(ok.status, 0, ok.output);
  const empty = identityCheck("IDENTITY_LOGIN_METHOD=local\n");
  assert.equal(empty.status, 1);
  for (const name of [...LOCAL, ...SMTP]) assert.match(empty.output, new RegExp(name));
  for (const name of ["IDENTITY_ACCOUNTS_DATABASE_URL", "IDENTITY_HANDOFF_PRIVATE_JWK", "IDENTITY_HUB_PUBLIC_JWK"])
    assert.doesNotMatch(empty.output, new RegExp(name), `${name} is not needed with local`);
});

test("identity, local without email: SMTP is not needed; sms needs Twilio", () => {
  const sms = identityCheck(`IDENTITY_LOGIN_METHOD=local\nIDENTITY_SIGN_IN_METHODS=sms,passkey\n${env(LOCAL)}`);
  assert.equal(sms.status, 1);
  assert.match(sms.output, /IDENTITY_TWILIO_ACCOUNT_SID/);
  assert.doesNotMatch(sms.output, /IDENTITY_SMTP/);
  const twilio = ["IDENTITY_TWILIO_ACCOUNT_SID", "IDENTITY_TWILIO_AUTH_TOKEN", "IDENTITY_TWILIO_FROM"];
  const legacy = identityCheck(`IDENTITY_LOGIN_METHOD=sms\n${env([...LOCAL, ...twilio])}`);
  assert.equal(legacy.status, 0, legacy.output);
});

test("identity, local with google: the Google client id and secret are needed too", () => {
  const google = ["IDENTITY_GOOGLE_CLIENT_ID", "IDENTITY_GOOGLE_CLIENT_SECRET"];
  const methods = "IDENTITY_SIGN_IN_METHODS=google,email,passkey";
  const missing = identityCheck(`IDENTITY_LOGIN_METHOD=local\n${methods}\n${env([...LOCAL, ...SMTP])}`);
  assert.equal(missing.status, 1);
  for (const name of google) assert.match(missing.output, new RegExp(name));
  const ok = identityCheck(`IDENTITY_LOGIN_METHOD=local\n${methods}\n${env([...LOCAL, ...SMTP, ...google])}`);
  assert.equal(ok.status, 0, ok.output);
});

test("identity: an unknown login method stops the check, naming the variable and never its value", () => {
  const result = identityCheck(`IDENTITY_LOGIN_METHOD=s3cr3t-typo\n${env(HUB)}`);
  assert.equal(result.status, 1);
  assert.match(result.output, /IDENTITY_LOGIN_METHOD/);
  assert.doesNotMatch(result.output, /s3cr3t/);
});

test("identity: a failure never prints a value", () => {
  const result = identityCheck("IDENTITY_LOGIN_METHOD=local\nIDENTITY_OIDC_JWKS=s3cr3t-jwks\n");
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.output, /s3cr3t/);
});

test("the docs example requires the app's secrets; only CORE_API_URL is still listed commented out (#83)", () => {
  const text = readFileSync(docsExample, "utf8");
  const required = [
    "AUTH_SECRET",
    "DOCS_GITHUB_TOKEN",
    "DOCS_ISSUES_TOKEN",
    "DOCS_AI_API_KEY",
    "DATABASE_URL",
    "ASAFARIM_REGISTRY_CREDENTIAL",
    "OIDC_CLIENT_SECRET",
  ];
  assert.deepEqual(text.match(/^[A-Z][A-Z0-9_]*(?==)/gm), required);
  const manifest = JSON.parse(readFileSync(path.join(root, "apps", "docs", "platform.app.json"), "utf8"));
  for (const name of manifest.secrets) assert.match(text, new RegExp(`^(# )?${name}=$`, "m"), `${name} is not listed`);
  assert.match(text, /^# CORE_API_URL=$/m);
  const empty = check("", text);
  assert.equal(empty.status, 1);
  for (const name of required) assert.match(empty.output, new RegExp(name));
  const filled = required.map((name) => `${name}=stand-in\n`).join("");
  assert.equal(check(filled, text).status, 0);
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
    "require_identity_env .env.identity core/identity/.env.production.example",
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
  assert.match(script, /chmod 600 \.env\.docs/);
});

test("docs.asafarim.site is published only after os-docs answers /api/health (#83)", () => {
  const ready = code.indexOf('if [[ "$docs_ready" != true ]]');
  const publish = code.indexOf('edge-deploy-site.sh" asafarim-os');
  assert.ok(ready > 0 && publish > ready);
  assert.match(code.slice(ready, publish), /fatal /, "a not-ready os-docs must stop the script before publishing");
  assert.match(code, /export DOCS_IMAGE_TAG="\$docs_image_commit"/);
  assert.ok(code.indexOf("export DOCS_IMAGE_TAG") < code.indexOf('"${compose[@]}" config -q'));
});

test("it can never print a secret: no set -x, no source/cat of the env, and `compose config` only with -q", () => {
  assert.doesNotMatch(code, /set -[a-z]*x/, "set -x would print every command, and its variables");
  assert.doesNotMatch(code, /\b(source|\.)\s+\S*\.env\.(identity|docs)/, "never source the secrets");
  assert.doesNotMatch(
    code,
    /\b(cat|less|head|tail|echo|printf)\b[^\n]*\.env\.(identity|docs)/,
    "never print the secrets",
  );
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
const DOCS_SHA = "c".repeat(40);
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
    docsEnv = true,
    docsEnvEmpty = false,
    coreApiEnv = false,
    coreApiEnvEmpty = false,
    adminEnv = false,
    adminEnvEmpty = false,
    flowEnv = false,
    flowEnvEmpty = false,
    pullFails = 0,
    pullAttempts = "",
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
      "sites/asafarim-os-flow.caddy",
      "core/identity/.env.production.example",
      "apps/docs/.env.production.example",
      "core/core-api/.env.production.example",
      "core/admin/.env.production.example",
      "apps/flow/.env.production.example",
    ]) {
      cpSync(path.join(root, file), path.join(repo, file), { recursive: true });
    }
    // Both modes decrypt the docs env (#83).
    mkdirSync(path.join(repo, ".age"));
    writeFileSync(path.join(repo, ".age", "key.txt"), "stand-in key\n");
    if (docsEnv) writeFileSync(path.join(repo, "apps/docs/.env.production.age"), "stand-in ciphertext\n");
    if (full) {
      writeFileSync(path.join(repo, "core/identity/.env.production.age"), "stand-in ciphertext\n");
      mkdirSync(path.join(repo, "deploy/identity"));
      writeFileSync(path.join(repo, "deploy/identity/clients.json"), "{}\n");
    }
    if (coreApiEnv) writeFileSync(path.join(repo, "core/core-api/.env.production.age"), "stand-in ciphertext\n");
    if (adminEnv) writeFileSync(path.join(repo, "core/admin/.env.production.age"), "stand-in ciphertext\n");
    if (flowEnv) writeFileSync(path.join(repo, "apps/flow/.env.production.age"), "stand-in ciphertext\n");
    const fill = (example) =>
      readFileSync(example, "utf8")
        .match(/^[A-Z][A-Z0-9_]*(?==)/gm)
        .map((n) => `echo ${n}=stand-in`)
        .join("\n");
    // The stand-in age "decrypts" each file into its example's names, filled (the docs one empty if asked).
    const filled = [
      `if [[ "$*" == *apps/docs/* ]]; then`,
      `  [[ -n "$DOCS_ENV_EMPTY" ]] && exit 0`,
      fill(docsExample),
      `elif [[ "$*" == *core/core-api/* ]]; then`,
      `  [[ -n "$CORE_API_ENV_EMPTY" ]] && exit 0`,
      fill(coreApiExample),
      `elif [[ "$*" == *core/admin/* ]]; then`,
      `  [[ -n "$ADMIN_ENV_EMPTY" ]] && exit 0`,
      fill(adminExample),
      `elif [[ "$*" == *apps/flow/* ]]; then`,
      `  [[ -n "$FLOW_ENV_EMPTY" ]] && exit 0`,
      fill(flowExample),
      `else`,
      fill(realExample),
      `fi`,
    ].join("\n");
    mkdirSync(bin);
    const stubs = {
      git: STUB("git"),
      flock: STUB("flock"),
      age: STUB("age", filled),
      docker: STUB(
        "docker",
        [
          `[[ "$1" == compose && -n "$COMPOSE_PROFILES" ]] && echo "profiles=$COMPOSE_PROFILES $*" >> "$CALLS"`,
          `case "$*" in`,
          // The first $PULL_FAILS pulls fail, as a host's containerd sometimes does for a moment.
          `  "compose "*" pull"|"compose "*" pull "*)`,
          `    n=$(( $(cat "$PULL_COUNT") + 1 )); echo "$n" > "$PULL_COUNT"`,
          `    (( n <= PULL_FAILS )) && exit 1 ;;`,
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
    writeFileSync(path.join(dir, "pull-count"), "0\n");
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
        DOCS_ENV_EMPTY: docsEnvEmpty ? "1" : "",
        CORE_API_ENV_EMPTY: coreApiEnvEmpty ? "1" : "",
        ADMIN_ENV_EMPTY: adminEnvEmpty ? "1" : "",
        FLOW_ENV_EMPTY: flowEnvEmpty ? "1" : "",
        PULL_FAILS: String(pullFails),
        PULL_COUNT: path.join(dir, "pull-count"),
        DEPLOY_PULL_RETRY_DELAY: "0",
        ...(pullAttempts === "" ? {} : { DEPLOY_PULL_ATTEMPTS: pullAttempts }),
      },
    });
    return {
      status: run.status,
      stderr: run.stderr,
      stdout: run.stdout,
      calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
      envIdentityWritten: existsSync(path.join(repo, ".env.identity")),
      envDocsWritten: existsSync(path.join(repo, ".env.docs")),
      envCoreApiWritten: existsSync(path.join(repo, ".env.core-api")),
      envAdminWritten: existsSync(path.join(repo, ".env.admin")),
      envFlowWritten: existsSync(path.join(repo, ".env.flow")),
      generatedSite: existsSync(path.join(repo, ".vps-deploy-site.caddy"))
        ? readFileSync(path.join(repo, ".vps-deploy-site.caddy"), "utf8")
        : null,
      liveSite: existsSync(liveSite) ? readFileSync(liveSite, "utf8") : null,
      repo,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const compose = "docker compose -p asafarim-os -f deploy/compose.prod.yml";

test("--site-only: decrypts the docs env only, never checks identity_db or clients.json, starts only os-site, os-docs, breinhap-site and igs-site, publishes the site-only file", () => {
  const r = runDeploy(["--site-only", SHA, SITE_SHA, DOCS_SHA]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.calls.filter((c) => c.startsWith("age ")),
    ["age -d -i .age/key.txt apps/docs/.env.production.age"],
    "only the docs env is decrypted",
  );
  assert.equal(r.envIdentityWritten, false, ".env.identity must not be written");
  assert.equal(r.envDocsWritten, true, ".env.docs is os-docs's env_file");
  assert.ok(!r.calls.some((c) => c.includes("identity_db")), "identity_db must not be checked");
  assert.ok(r.calls.includes("docker network inspect edge_net"));
  assert.ok(r.calls.includes("git reset --hard " + SHA));
  const composeCalls = r.calls.filter((c) => c.startsWith(compose)).map((c) => c.slice(compose.length + 1));
  assert.deepEqual(composeCalls, [
    "ps -q identity",
    "config -q --no-env-resolution os-site os-docs breinhap-site igs-site",
    "pull os-site os-docs breinhap-site igs-site",
    "up -d --no-deps os-site os-docs breinhap-site igs-site",
    "exec -T os-site wget -qO- http://127.0.0.1:8080/healthz",
    "exec -T breinhap-site wget -qO- http://127.0.0.1:8080/healthz",
    "exec -T igs-site wget -qO- http://127.0.0.1:8080/healthz",
    "exec -T os-docs wget -qO- http://127.0.0.1:3000/api/health",
  ]);
  assert.ok(r.calls.includes(`edge-deploy-site.sh asafarim-os ${r.repo}/sites/asafarim-os-site.caddy`));
});

test("--site-only without apps/docs/.env.production.age in the commit stops before pulling anything (#83)", () => {
  const r = runDeploy(["--site-only", SHA], { docsEnv: false });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /apps\/docs\/\.env\.production\.age is not in this commit/);
  assert.ok(!r.calls.some((c) => / (pull|up) /.test(c) || c.startsWith("edge-deploy-site.sh")), r.calls.join("\n"));
});

test("a docs env without AUTH_SECRET stops the deploy, naming the variable and never a value (#83)", () => {
  const r = runDeploy(["--site-only", SHA], { docsEnvEmpty: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing or empty in \.env\.docs: AUTH_SECRET/);
  assert.ok(!r.calls.some((c) => / (pull|up) /.test(c)), r.calls.join("\n"));
});

test("--site-only refuses to run while identity is running, and changes nothing", () => {
  const r = runDeploy(["--site-only", SHA], { identityRunning: "0123456789ab" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /identity is running/);
  assert.ok(!r.calls.some((c) => / (pull|up) /.test(c) || c.startsWith("edge-deploy-site.sh")), r.calls.join("\n"));
  assert.equal(r.liveSite, null);
});

test("--site-only takes at most three shas, each a full sha", () => {
  assert.match(runDeploy(["--site-only", SHA, SITE_SHA, DOCS_SHA, SHA]).stderr, /usage:/);
  assert.match(runDeploy(["--site-only", SHA, "abc"]).stderr, /<site-image-commit> must be a full 40-character sha/);
  assert.match(
    runDeploy(["--site-only", SHA, SITE_SHA, "abc"]).stderr,
    /<docs-image-commit> must be a full 40-character sha/,
  );
  assert.match(runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA, SHA, SHA, SHA, SHA], { full: true }).stderr, /usage:/);
  assert.match(
    runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA, "abc"], { full: true }).stderr,
    /<core-api-image-commit> must be a full 40-character sha/,
  );
  assert.match(
    runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA, SHA, "abc"], { full: true }).stderr,
    /<admin-image-commit> must be a full 40-character sha/,
  );
  assert.match(runDeploy(["--site-only"]).stderr, /usage:/);
});

test("full mode still decrypts, checks, starts the whole stack, waits for all five and publishes the full site file", () => {
  const r = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA], { full: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.includes("age -d -i .age/key.txt core/identity/.env.production.age"));
  assert.ok(r.calls.includes("age -d -i .age/key.txt apps/docs/.env.production.age"));
  assert.equal(r.envDocsWritten, true);
  assert.ok(r.calls.includes("docker network inspect identity_db"));
  const composeCalls = r.calls.filter((c) => c.startsWith(compose)).map((c) => c.slice(compose.length + 1));
  assert.deepEqual(composeCalls, [
    "config -q",
    "pull",
    "up -d --remove-orphans",
    "exec -T identity wget -qO- http://127.0.0.1:3000/readyz",
    "exec -T os-site wget -qO- http://127.0.0.1:8080/healthz",
    "exec -T breinhap-site wget -qO- http://127.0.0.1:8080/healthz",
    "exec -T igs-site wget -qO- http://127.0.0.1:8080/healthz",
    "exec -T os-docs wget -qO- http://127.0.0.1:3000/api/health",
  ]);
  assert.ok(r.calls.includes(`edge-deploy-site.sh asafarim-os ${r.repo}/sites/asafarim-os.caddy`));
});

test("full mode, before the cutover: the live Caddy gets the FULL site file (with id.asafarim.site), after the edge", () => {
  const r = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA], { full: true });
  assert.equal(r.status, 0, r.stderr);
  const fullFile = readFileSync(path.join(root, "sites", "asafarim-os.caddy"), "utf8");
  assert.equal(r.liveSite, fullFile, "sites.local/asafarim-os.caddy is the full file");
  assert.match(r.liveSite ?? "", /^id\.asafarim\.site \{/m);
  const edgeAt = r.calls.findIndex((c) => c.startsWith("edge-deploy-site.sh"));
  const reloadAt = r.calls.indexOf(
    "docker exec live0caddy01 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile",
  );
  assert.ok(edgeAt >= 0 && reloadAt > edgeAt, r.calls.join("\n"));
});

test("full mode: a live Caddy that refuses the file fails the deploy and leaves the live file unchanged", () => {
  const r = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA], {
    full: true,
    live: { id: "live0caddy01", networks: "edge_net", validate: 1, reload: 0 },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the live Caddy did not take sites\/asafarim-os\.caddy/);
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

// core-api: part of the full deploy once core/core-api/.env.production.age is committed, and only then.
const CORE_SHA = "d".repeat(40);

test("full mode without core/core-api/.env.production.age: exactly the deploy as before, no core profile", () => {
  const r = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA, CORE_SHA], { full: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.some((c) => c.includes("core/core-api")), "the core-api env is not decrypted");
  assert.equal(r.envCoreApiWritten, false);
  assert.ok(!r.calls.some((c) => c.startsWith("profiles=")), "the core profile is off");
  assert.ok(!r.calls.some((c) => c.includes("os-core-api")), "core-api is not waited for");
});

test("full mode with core/core-api/.env.production.age: decrypts and checks it, starts the core profile, waits for core-api before publishing", () => {
  const r = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA, CORE_SHA], { full: true, coreApiEnv: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.includes("age -d -i .age/key.txt core/core-api/.env.production.age"));
  assert.equal(r.envCoreApiWritten, true, ".env.core-api is os-postgres's and os-core-api's env_file");
  const profiled = r.calls.filter((c) => c.startsWith("profiles=core ")).map((c) => c.slice("profiles=core ".length));
  assert.deepEqual(
    profiled.map((c) => c.replace(`${compose.slice("docker ".length)} `, "")),
    [
      "config -q",
      "pull",
      "up -d --remove-orphans",
      "exec -T identity wget -qO- http://127.0.0.1:3000/readyz",
      "exec -T os-core-api wget -qO- http://127.0.0.1:4020/readyz",
      "exec -T os-site wget -qO- http://127.0.0.1:8080/healthz",
      "exec -T breinhap-site wget -qO- http://127.0.0.1:8080/healthz",
      "exec -T igs-site wget -qO- http://127.0.0.1:8080/healthz",
      "exec -T os-docs wget -qO- http://127.0.0.1:3000/api/health",
    ],
  );
  const coreReadyAt = r.calls.findIndex((c) =>
    c.endsWith("exec -T os-core-api wget -qO- http://127.0.0.1:4020/readyz"),
  );
  const edgeAt = r.calls.findIndex((c) => c.startsWith("edge-deploy-site.sh"));
  assert.ok(coreReadyAt >= 0 && edgeAt > coreReadyAt, r.calls.join("\n"));
});

test("a core-api env with a variable missing stops the deploy before pulling, naming it and never a value", () => {
  const r = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA, CORE_SHA], {
    full: true,
    coreApiEnv: true,
    coreApiEnvEmpty: true,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing or empty in \.env\.core-api: POSTGRES_PASSWORD/);
  assert.match(r.stderr, /node deploy\/core-api\/new-env\.mjs/);
  assert.ok(!r.calls.some((c) => / (pull|up) /.test(c)), r.calls.join("\n"));
});

// The Admin console (#175): part of the full deploy next to core-api, once core/admin/.env.production.age is committed.
test("without core/admin/.env.production.age: the admin env is not decrypted, no admin profile, os-admin is not waited for", () => {
  const r = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA, CORE_SHA, SHA], { full: true, coreApiEnv: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.some((c) => c.includes("core/admin")));
  assert.equal(r.envAdminWritten, false);
  assert.ok(r.calls.some((c) => c.startsWith("profiles=core ")));
  assert.ok(!r.calls.some((c) => c.startsWith("profiles=core,admin") || c.includes("os-admin")));
});

test("with core/admin/.env.production.age: decrypts and checks it, starts the admin profile, waits for os-admin before publishing", () => {
  const r = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA, CORE_SHA, SHA], { full: true, coreApiEnv: true, adminEnv: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.includes("age -d -i .age/key.txt core/admin/.env.production.age"));
  assert.equal(r.envAdminWritten, true, ".env.admin is os-admin's env_file");
  const profiled = r.calls
    .filter((c) => c.startsWith("profiles=core,admin "))
    .map((c) => c.slice("profiles=core,admin ".length));
  assert.ok(
    profiled.some((c) => c.endsWith("exec -T os-admin wget -qO- http://127.0.0.1:3000/api/health")),
    r.calls.join("\n"),
  );
  const adminReadyAt = r.calls.findIndex((c) =>
    c.endsWith("exec -T os-admin wget -qO- http://127.0.0.1:3000/api/health"),
  );
  const edgeAt = r.calls.findIndex((c) => c.startsWith("edge-deploy-site.sh"));
  assert.ok(adminReadyAt >= 0 && edgeAt > adminReadyAt, r.calls.join("\n"));
});

test("an admin env with a variable missing stops the deploy before pulling, naming it and never a value", () => {
  const r = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA, CORE_SHA, SHA], {
    full: true,
    coreApiEnv: true,
    adminEnv: true,
    adminEnvEmpty: true,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing or empty in \.env\.admin: AUTH_SECRET OIDC_CLIENT_SECRET/);
  assert.ok(!r.calls.some((c) => / (pull|up) /.test(c)), r.calls.join("\n"));
});

test("the admin env without core-api's is refused before anything is pulled: the console is a client of core-api", () => {
  const r = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA, CORE_SHA, SHA], { full: true, adminEnv: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the Admin console needs core-api/);
  assert.ok(!r.calls.some((c) => / (pull|up) /.test(c)));
});

test("--site-only never touches the Admin console, even when its env is committed", () => {
  const r = runDeploy(["--site-only", SHA], { adminEnv: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.some((c) => c.includes("core/admin") || c.includes("os-admin")), r.calls.join("\n"));
  assert.equal(r.envAdminWritten, false);
});

test("--site-only never touches core-api, even when its env is committed", () => {
  const r = runDeploy(["--site-only", SHA], { coreApiEnv: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.some((c) => c.includes("core/core-api") || c.startsWith("profiles=")), r.calls.join("\n"));
  assert.equal(r.envCoreApiWritten, false);
});

test("the core-api example lists the six variables new-env.mjs writes, and its output fills them all", async () => {
  const names = readFileSync(coreApiExample, "utf8").match(/^[A-Z][A-Z0-9_]*(?==)/gm);
  assert.deepEqual(names, [
    "POSTGRES_PASSWORD",
    "CORE_API_DB_PASSWORD",
    "CORE_API_DATABASE_URL",
    "CORE_API_PROVISIONER_URL",
    "CORE_API_ADMIN_TOKEN",
    "CORE_API_TOKEN_SIGNING_JWK",
  ]);
  const { newEnv } = await import("./core-api/new-env.mjs");
  const text = newEnv();
  assert.equal(check(text, readFileSync(coreApiExample, "utf8")).status, 0);
  const env = Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  assert.equal(new URL(env.CORE_API_DATABASE_URL).password, env.CORE_API_DB_PASSWORD);
  assert.equal(new URL(env.CORE_API_DATABASE_URL).host, "os-postgres:5432");
  assert.equal(new URL(env.CORE_API_PROVISIONER_URL).password, env.POSTGRES_PASSWORD);
  assert.ok(env.CORE_API_ADMIN_TOKEN.length >= 32);
  const jwk = JSON.parse(env.CORE_API_TOKEN_SIGNING_JWK);
  assert.equal(jwk.kty, "OKP");
  assert.equal(jwk.crv, "Ed25519");
  assert.ok(jwk.d && jwk.x && jwk.kid);
  assert.notEqual(newEnv(), text, "every run is new");
});

// A pull that fails for a moment on the host (containerd's "failed commit on ref ... rename ... no such file", seen on
// the cc3988d deploy) is tried again before the deploy gives up.
const composeCallsOf = (r) => r.calls.filter((c) => c.startsWith(compose)).map((c) => c.slice(compose.length + 1));

test("full mode: a pull that fails once is tried again, and the deploy goes on", () => {
  const r = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA], { full: true, pullFails: 1 });
  assert.equal(r.status, 0, r.stderr);
  const calls = composeCallsOf(r);
  assert.deepEqual(calls.slice(0, 4), ["config -q", "pull", "pull", "up -d --remove-orphans"]);
  assert.match(r.stdout, /The pull failed \(attempt 1 of 3\)\. Trying again in 0s/);
  assert.ok(
    r.calls.some((c) => c.startsWith("edge-deploy-site.sh")),
    "the site is published",
  );
});

test("full mode: three failed pulls stop the deploy before anything starts or is published", () => {
  const r = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA], { full: true, pullFails: 3 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FATAL: the pull failed\./);
  assert.match(r.stdout, /The pull failed 3 time\(s\)\./);
  assert.deepEqual(composeCallsOf(r), ["config -q", "pull", "pull", "pull"]);
  assert.ok(!r.calls.some((c) => / up /.test(c) || c.startsWith("edge-deploy-site.sh")), r.calls.join("\n"));
  assert.equal(r.liveSite, null);
});

test("--site-only: the os-site, os-docs, breinhap-site and igs-site pull is tried again too", () => {
  const ok = runDeploy(["--site-only", SHA, SITE_SHA, DOCS_SHA], { pullFails: 2 });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(
    composeCallsOf(ok).filter((c) => c.startsWith("pull") || c.startsWith("up")),
    [
      "pull os-site os-docs breinhap-site igs-site",
      "pull os-site os-docs breinhap-site igs-site",
      "pull os-site os-docs breinhap-site igs-site",
      "up -d --no-deps os-site os-docs breinhap-site igs-site",
    ],
  );
  const failed = runDeploy(["--site-only", SHA, SITE_SHA, DOCS_SHA], { pullFails: 3 });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /FATAL: the pull failed\./);
  assert.ok(!failed.calls.some((c) => / up /.test(c) || c.startsWith("edge-deploy-site.sh")), failed.calls.join("\n"));
});

test("DEPLOY_PULL_ATTEMPTS sets the number of tries, and a bad value stops before anything runs", () => {
  const once = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA], { full: true, pullFails: 1, pullAttempts: "1" });
  assert.equal(once.status, 1);
  assert.deepEqual(composeCallsOf(once), ["config -q", "pull"]);
  for (const bad of ["0", "two", "-1"]) {
    const r = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA], { full: true, pullAttempts: bad });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /DEPLOY_PULL_ATTEMPTS must be a whole number of at least 1/);
    assert.ok(!r.calls.some((c) => c.startsWith("git reset")), r.calls.join("\n"));
  }
});

// Flow (flow.asafarim.site): part of the full deploy next to core-api, once apps/flow/.env.production.age is committed.
// Without it, a deploy must be EXACTLY what it was: the same commands, the same site file, byte for byte.
const FLOW_SHA = "e".repeat(40);
const fullSite = readFileSync(path.join(root, "sites", "asafarim-os.caddy"), "utf8");
const flowSite = readFileSync(path.join(root, "sites", "asafarim-os-flow.caddy"), "utf8");

test("without apps/flow/.env.production.age: no Flow env, no flow profile, os-flow never touched, the site file unchanged", () => {
  for (const [args, opts] of [
    [[SHA, SHA, SITE_SHA, DOCS_SHA], { full: true }],
    [[SHA, SHA, SITE_SHA, DOCS_SHA, CORE_SHA], { full: true, coreApiEnv: true }],
    [[SHA, SHA, SITE_SHA, DOCS_SHA, CORE_SHA, SHA], { full: true, coreApiEnv: true, adminEnv: true }],
    [[SHA, SHA, SITE_SHA, DOCS_SHA, CORE_SHA, SHA, FLOW_SHA], { full: true, coreApiEnv: true }],
  ]) {
    const r = runDeploy(args, opts);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.calls.some((c) => c.includes("apps/flow") || c.includes("os-flow")), r.calls.join("\n"));
    assert.ok(!r.calls.some((c) => /^profiles=\S*flow/.test(c)), "the flow profile is off");
    assert.equal(r.envFlowWritten, false);
    assert.equal(r.generatedSite, null, "no generated site file");
    assert.ok(
      r.calls.includes(`edge-deploy-site.sh asafarim-os ${r.repo}/sites/asafarim-os.caddy`),
      r.calls.join("\n"),
    );
    assert.equal(r.liveSite, fullSite, "the live Caddy gets sites/asafarim-os.caddy, byte for byte");
    assert.doesNotMatch(r.liveSite ?? "", /flow\.asafarim\.site/);
  }
});

test("without apps/flow/.env.production.age: the compose commands are exactly those of the deploy before Flow", () => {
  const r = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA, CORE_SHA, SHA], { full: true, coreApiEnv: true, adminEnv: true });
  assert.equal(r.status, 0, r.stderr);
  const profiled = r.calls
    .filter((c) => c.startsWith("profiles=core,admin "))
    .map((c) => c.slice("profiles=core,admin ".length).replace(`${compose.slice("docker ".length)} `, ""));
  assert.deepEqual(profiled, [
    "config -q",
    "pull",
    "up -d --remove-orphans",
    "exec -T identity wget -qO- http://127.0.0.1:3000/readyz",
    "exec -T os-core-api wget -qO- http://127.0.0.1:4020/readyz",
    "exec -T os-admin wget -qO- http://127.0.0.1:3000/api/health",
    "exec -T os-site wget -qO- http://127.0.0.1:8080/healthz",
    "exec -T breinhap-site wget -qO- http://127.0.0.1:8080/healthz",
    "exec -T igs-site wget -qO- http://127.0.0.1:8080/healthz",
    "exec -T os-docs wget -qO- http://127.0.0.1:3000/api/health",
  ]);
});

test("with apps/flow/.env.production.age: decrypts and checks it, starts the flow profile, waits for os-flow, then publishes flow.asafarim.site", () => {
  const r = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA, CORE_SHA, SHA, FLOW_SHA], {
    full: true,
    coreApiEnv: true,
    flowEnv: true,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.includes("age -d -i .age/key.txt apps/flow/.env.production.age"));
  assert.equal(r.envFlowWritten, true, ".env.flow is os-flow's env_file");
  const profiled = r.calls
    .filter((c) => c.startsWith("profiles=core,flow "))
    .map((c) => c.slice("profiles=core,flow ".length).replace(`${compose.slice("docker ".length)} `, ""));
  assert.deepEqual(profiled, [
    "config -q",
    "pull",
    "up -d --remove-orphans",
    "exec -T identity wget -qO- http://127.0.0.1:3000/readyz",
    "exec -T os-core-api wget -qO- http://127.0.0.1:4020/readyz",
    "exec -T os-flow wget -qO- http://127.0.0.1:3000/health/ready",
    "exec -T os-site wget -qO- http://127.0.0.1:8080/healthz",
    "exec -T breinhap-site wget -qO- http://127.0.0.1:8080/healthz",
    "exec -T igs-site wget -qO- http://127.0.0.1:8080/healthz",
    "exec -T os-docs wget -qO- http://127.0.0.1:3000/api/health",
  ]);
  assert.match(r.stdout, new RegExp(`:flow-${FLOW_SHA}`), "the pull names the flow image");
  const flowReadyAt = r.calls.findIndex((c) =>
    c.endsWith("exec -T os-flow wget -qO- http://127.0.0.1:3000/health/ready"),
  );
  const edgeAt = r.calls.findIndex((c) => c.startsWith("edge-deploy-site.sh"));
  assert.ok(flowReadyAt >= 0 && edgeAt > flowReadyAt, r.calls.join("\n"));
  // The published file: the full site file with the Flow block appended, under the same edge site name.
  assert.ok(r.calls.includes(`edge-deploy-site.sh asafarim-os ${r.repo}/.vps-deploy-site.caddy`), r.calls.join("\n"));
  assert.equal(r.generatedSite, fullSite + flowSite);
  assert.equal(r.liveSite, fullSite + flowSite, "the live Caddy gets the same file");
  assert.match(r.stdout, /curl -fsS https:\/\/flow\.asafarim\.site\/health\/live/);
});

test("with the Admin console and Flow: both profiles on top of core", () => {
  const r = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA, CORE_SHA, SHA, FLOW_SHA], {
    full: true,
    coreApiEnv: true,
    adminEnv: true,
    flowEnv: true,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(
    r.calls.some((c) => c.startsWith("profiles=core,admin,flow ")),
    r.calls.join("\n"),
  );
  assert.equal(r.generatedSite, fullSite + flowSite);
});

test("a Flow env with a variable missing stops the deploy before pulling, naming it and never a value", () => {
  const r = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA, CORE_SHA, SHA, FLOW_SHA], {
    full: true,
    coreApiEnv: true,
    flowEnv: true,
    flowEnvEmpty: true,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing or empty in \.env\.flow: AUTH_SECRET OIDC_CLIENT_SECRET/);
  assert.match(r.stderr, /node deploy\/flow\/new-env\.mjs/);
  assert.ok(!r.calls.some((c) => / (pull|up) /.test(c) || c.startsWith("edge-deploy-site.sh")), r.calls.join("\n"));
});

test("the Flow env without core-api's is refused before anything is pulled: Flow needs core-api", () => {
  const r = runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA, CORE_SHA, SHA, FLOW_SHA], { full: true, flowEnv: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Flow needs core-api/);
  assert.ok(!r.calls.some((c) => / (pull|up) /.test(c)));
  assert.equal(r.envFlowWritten, false);
});

test("--site-only never touches Flow, even when its env is committed", () => {
  const r = runDeploy(["--site-only", SHA], { coreApiEnv: true, flowEnv: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.some((c) => c.includes("apps/flow") || c.includes("os-flow")), r.calls.join("\n"));
  assert.equal(r.envFlowWritten, false);
  assert.equal(r.generatedSite, null);
  assert.ok(r.calls.includes(`edge-deploy-site.sh asafarim-os ${r.repo}/sites/asafarim-os-site.caddy`));
});

test("<flow-image-commit> is a seventh, optional sha, checked like the others; an eighth is refused", () => {
  assert.match(
    runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA, SHA, SHA, "abc"], { full: true }).stderr,
    /<flow-image-commit> must be a full 40-character sha/,
  );
  assert.match(runDeploy([SHA, SHA, SITE_SHA, DOCS_SHA, SHA, SHA, SHA, SHA], { full: true }).stderr, /usage:/);
  assert.match(code, /export FLOW_IMAGE_TAG="\$flow_image_commit"/);
  assert.ok(code.indexOf("export FLOW_IMAGE_TAG") < code.indexOf('"${compose[@]}" config -q'));
});

test("the Flow example requires AUTH_SECRET and OIDC_CLIENT_SECRET; the install's two are listed commented out", () => {
  const text = readFileSync(flowExample, "utf8");
  assert.deepEqual(text.match(/^[A-Z][A-Z0-9_]*(?==)/gm), ["AUTH_SECRET", "OIDC_CLIENT_SECRET"]);
  assert.match(text, /^# DATABASE_URL=$/m);
  assert.match(text, /^# ASAFARIM_REGISTRY_CREDENTIAL=$/m);
  assert.doesNotMatch(text, /^(# )?ASAFARIM_NATS_URL=/m, "production has no bus: Flow's env names none");
});

test("deploy/flow/new-env.mjs fills the Flow example, gives identity the same client secret, and overwrites nothing", async () => {
  const { newEnv, writeEnv, IDENTITY_SECRET_NAME } = await import("./flow/new-env.mjs");
  const parse = (text) =>
    Object.fromEntries(
      text
        .split("\n")
        .filter((l) => /^[A-Z]/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  const generated = newEnv();
  assert.equal(check(generated.flow, readFileSync(flowExample, "utf8")).status, 0);
  assert.equal(parse(generated.identity)[IDENTITY_SECRET_NAME], parse(generated.flow).OIDC_CLIENT_SECRET);
  assert.ok(parse(generated.flow).AUTH_SECRET.length >= 32);
  assert.notEqual(newEnv().flow, generated.flow, "every run is new");

  const dir = mkdtempSync(path.join(tmpdir(), "flow-new-env-"));
  try {
    const flowFile = path.join(dir, "flow.env");
    const identityFile = path.join(dir, "identity.env");
    // identity's env not decrypted: nothing is written.
    assert.match(writeEnv({ flowFile, identityFile }), /pnpm env:decrypt:production/);
    assert.equal(existsSync(flowFile), false);
    writeFileSync(identityFile, "IDENTITY_OIDC_JWKS=stand-in");
    assert.equal(writeEnv({ flowFile, identityFile }), undefined);
    const flowEnv = parse(readFileSync(flowFile, "utf8"));
    const identityEnv = parse(readFileSync(identityFile, "utf8"));
    assert.equal(identityEnv.IDENTITY_OIDC_JWKS, "stand-in", "identity's own lines are kept");
    assert.equal(identityEnv[IDENTITY_SECRET_NAME], flowEnv.OIDC_CLIENT_SECRET);
    assert.equal(statSync(flowFile).mode & 0o777, 0o600);
    // A second run changes nothing: identity already names the secret.
    const before = [readFileSync(flowFile, "utf8"), readFileSync(identityFile, "utf8")];
    assert.match(writeEnv({ flowFile, identityFile }), new RegExp(`already has ${IDENTITY_SECRET_NAME}`));
    rmSync(flowFile);
    assert.match(writeEnv({ flowFile, identityFile }), /already has/);
    assert.equal(existsSync(flowFile), false);
    // An existing Flow env is never overwritten, and identity's then stays as it was.
    writeFileSync(flowFile, before[0]);
    writeFileSync(identityFile, "IDENTITY_OIDC_JWKS=stand-in\n");
    assert.match(writeEnv({ flowFile, identityFile }), /already exists: not overwriting it/);
    assert.equal(readFileSync(flowFile, "utf8"), before[0]);
    assert.equal(readFileSync(identityFile, "utf8"), "IDENTITY_OIDC_JWKS=stand-in\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deploy/flow/new-env.mjs prints file names, never a value", () => {
  const source = readFileSync(path.join(root, "deploy", "flow", "new-env.mjs"), "utf8");
  for (const m of source.matchAll(/console\.(log|error)\(([\s\S]*?)\);/g)) {
    assert.doesNotMatch(m[2], /\benv\.(flow|identity)\b|secret\(|clientSecret/, `it must not print a value: ${m[2]}`);
  }
});
