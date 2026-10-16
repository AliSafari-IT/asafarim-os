// deploy/ci-deploy.sh, the forced command behind the Deploy workflow's SSH key: it accepts exactly `deploy <sha on main>`
// and nothing else. The real script runs here against a throwaway origin repository and a stand-in for the repository's
// own deploy/redeploy.sh, which logs what it is asked to do. The last tests hold .github/workflows/deploy.yml to the
// same contract.
//
//   node --test deploy/ci-deploy.test.mjs          (needs bash and git)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(path.join(root, "deploy", "ci-deploy.sh"), "utf8");
const workflow = readFileSync(path.join(root, ".github", "workflows", "deploy.yml"), "utf8");
const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(cwd, message, files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), text);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** origin.git with c0 (the real ci-deploy.sh, a stand-in redeploy.sh) and c1; `vps`, a clone left at c0. */
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-deploy-"));
  const src = path.join(dir, "src");
  const origin = path.join(dir, "origin.git");
  const vps = path.join(dir, "vps");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  for (const [file, text] of Object.entries({
    "deploy/ci-deploy.sh": script,
    "deploy/redeploy.sh": '#!/usr/bin/env bash\necho "redeploy $* (HEAD $(git rev-parse HEAD))" >> "$CALLS"\n',
  })) {
    mkdirSync(path.dirname(path.join(src, file)), { recursive: true });
    writeFileSync(path.join(src, file), text, { mode: 0o755 });
  }
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "scripts");
  const c0 = git(src, "rev-parse", "HEAD");
  const c1 = commit(src, "site", { "core/site/index.html": "v1" });
  git(dir, "clone", "-q", "--bare", src, origin);
  git(dir, "clone", "-q", origin, vps);
  git(vps, "reset", "-q", "--hard", c0);
  writeFileSync(path.join(dir, "calls.log"), "");
  return { dir, vps, c0, c1, calls: path.join(dir, "calls.log") };
}

/** Run as sshd runs a forced command: the request in SSH_ORIGINAL_COMMAND (unless `request` is undefined). */
function run(env, request, args = []) {
  const vars = { ...process.env, CALLS: env.calls };
  delete vars.SSH_ORIGINAL_COMMAND;
  if (request !== undefined) vars.SSH_ORIGINAL_COMMAND = request;
  const r = spawnSync("bash", [path.join(env.vps, "deploy/ci-deploy.sh"), ...args], {
    cwd: "/",
    encoding: "utf8",
    env: vars,
  });
  return {
    status: r.status,
    output: `${r.stdout}${r.stderr}`,
    calls: readFileSync(env.calls, "utf8").trim().split("\n").filter(Boolean),
    head: git(env.vps, "rev-parse", "HEAD"),
  };
}

function withSetup(fn) {
  const env = setup();
  try {
    fn(env);
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
}

test("`deploy <sha>`: brings the checkout to that commit, then runs that commit's redeploy.sh <sha>", () =>
  withSetup((env) => {
    const r = run(env, `deploy ${env.c1}`);
    assert.equal(r.status, 0, r.output);
    assert.equal(r.head, env.c1);
    assert.deepEqual(r.calls, [`redeploy ${env.c1} (HEAD ${env.c1})`]);
  }));

test("an older commit on main is allowed (the workflow's rollback button)", () =>
  withSetup((env) => {
    git(env.vps, "reset", "-q", "--hard", env.c1);
    const r = run(env, `deploy ${env.c0}`);
    assert.equal(r.status, 0, r.output);
    assert.equal(r.head, env.c0);
    assert.deepEqual(r.calls, [`redeploy ${env.c0} (HEAD ${env.c0})`]);
  }));

test("anything but exactly `deploy <full lowercase sha>` is refused, and nothing runs", () =>
  withSetup((env) => {
    for (const request of [
      "",
      "deploy",
      "bash",
      `deploy ${env.c1.slice(0, 12)}`,
      `deploy ${env.c1.toUpperCase()}`,
      `deploy ${env.c1} extra`,
      `deploy ${env.c1}; touch /tmp/pwned`,
      `deploy ${env.c1}\ntouch /tmp/pwned`,
      ` deploy ${env.c1}`,
      `deploy  ${env.c1}`,
      `deploy $(id)`,
      `redeploy ${env.c1}`,
    ]) {
      const r = run(env, request);
      assert.equal(r.status, 2, `${JSON.stringify(request)}: ${r.output}`);
      assert.match(r.output, /usage: deploy <full 40-character sha on origin\/main>/);
      assert.equal(r.head, env.c0);
    }
    assert.deepEqual(readFileSync(env.calls, "utf8"), "", "nothing was run");
  }));

test("a sha not on origin/main, or not in the repository, is refused and changes nothing", () =>
  withSetup((env) => {
    git(env.vps, "checkout", "-q", "-b", "side");
    const side = commit(env.vps, "side", { "x.txt": "x" });
    git(env.vps, "checkout", "-q", "--detach", env.c0);
    for (const [sha, why] of [
      [side, /is not on origin\/main/],
      ["0".repeat(40), /is not in this repository/],
    ]) {
      const r = run(env, `deploy ${sha}`);
      assert.equal(r.status, 1, r.output);
      assert.match(r.output, why);
      assert.equal(r.head, env.c0);
    }
    assert.deepEqual(readFileSync(env.calls, "utf8"), "", "nothing was run");
  }));

test("by hand, without SSH_ORIGINAL_COMMAND, it takes the same words as arguments", () =>
  withSetup((env) => {
    const r = run(env, undefined, ["deploy", env.c1]);
    assert.equal(r.status, 0, r.output);
    assert.deepEqual(r.calls, [`redeploy ${env.c1} (HEAD ${env.c1})`]);
  }));

test("over SSH, arguments are ignored: only SSH_ORIGINAL_COMMAND counts", () =>
  withSetup((env) => {
    const r = run(env, "", ["deploy", env.c1]);
    assert.equal(r.status, 2, r.output);
    assert.equal(r.head, env.c0);
  }));

test("it is valid bash, runs main() on one last line, and never prints a secret", () => {
  const r = spawnSync("bash", ["-n", path.join(root, "deploy", "ci-deploy.sh")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(script.trimEnd().split("\n").at(-1), 'main "$@"; exit $?');
  assert.doesNotMatch(script, /set -[a-z]*x/);
  assert.doesNotMatch(script, /\beval\b|bash -c|\.env\.identity|age -d/);
});

test("deploy.yml: runs after the CI workflow, and only for a green push to main of this repository", () => {
  const ci = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /^name: CI$/m);
  assert.match(workflow, /workflow_run:\n {4}workflows: \[CI\]\n {4}types: \[completed\]\n {4}branches: \[main\]/);
  for (const condition of [
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.head_repository.full_name == github.repository",
  ]) {
    assert.ok(workflow.includes(condition), condition);
  }
  assert.match(workflow, /group: os-deploy\n {2}cancel-in-progress: false/);
});

test("deploy.yml: asks the VPS for exactly `deploy <sha>`, and waits only on redeploy.sh's exit code 3", () => {
  assert.match(workflow, /"\$\{DEPLOY_USER\}@\$\{DEPLOY_HOST\}" "deploy \$\{SHA\}"/);
  assert.match(workflow, /-o StrictHostKeyChecking=yes/);
  assert.match(workflow, /deploy\/redeploy\.sh --dry-run "\$SHA"/);
  assert.match(workflow, /elif \[\[ \$code -ne 3 \]\]/);
  const redeploy = readFileSync(path.join(root, "deploy", "redeploy.sh"), "utf8");
  assert.match(redeploy, /is not published \(yet\)[^\n]*\n\s*exit 3/);
});

test("deploy.yml: no ${{ }} expression is expanded inside a run script (values go through env)", () => {
  const runs = [...workflow.matchAll(/^( +)run: \|\n((?:\1 {2}[^\n]*\n|\n)+)/gm)].map((m) => m[2]);
  assert.ok(runs.length >= 5, "the run blocks were not found: update this test with the workflow");
  for (const body of runs) assert.doesNotMatch(body, /\$\{\{/);
});
