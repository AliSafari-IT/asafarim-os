// deploy/vps-deploy.sh and its env checker (asafarim-os#45). The script itself needs the VPS (docker, age, the
// edge), so what is tested here is what can be: the check that decides whether secrets are filled in, and the
// SHAPE of the script (its order, and that it can never print a secret).
//
//   node --test deploy/vps-deploy.test.mjs          (needs bash)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
