// deploy/redeploy.sh (the `pnpm redeploy` command): it works out the newest commit and the newest site image by
// itself. The real script runs here against a throwaway origin repository and stand-ins for docker and for the
// repository's own deploy/vps-deploy.sh, which log what they are asked to do.
//
//   node --test deploy/redeploy.test.mjs          (needs bash and git)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(path.join(root, "deploy", "redeploy.sh"), "utf8");
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

/** Commit `files` (path → text) in `cwd` and return the new commit's sha. */
function commit(cwd, message, files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), text);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/**
 * origin.git with three commits, and `vps`, a clone of it left at the FIRST commit (as a VPS that has not deployed
 * since):
 *   c0  adds the scripts (the real redeploy.sh and a stand-in vps-deploy.sh) and a site file
 *   c1  changes the site (core/site/deep/page.html)           ← the newest commit the site image is built from
 *   c2  changes something else (README)                       ← the newest commit on main
 */
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "redeploy-"));
  const src = path.join(dir, "src");
  const origin = path.join(dir, "origin.git");
  const vps = path.join(dir, "vps");
  const bin = path.join(dir, "bin");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  const c0 = commit(src, "scripts", {
    "deploy/redeploy.sh": script,
    "deploy/vps-deploy.sh": '#!/usr/bin/env bash\necho "vps-deploy $* (HEAD $(git rev-parse HEAD))" >> "$CALLS"\n',
    "core/site/index.html": "v0",
    "README.md": "r0",
  });
  // As in the real repository, both scripts are executable files in git (and stay so in later commits).
  for (const file of ["deploy/redeploy.sh", "deploy/vps-deploy.sh"]) chmodSync(path.join(src, file), 0o755);
  git(src, "add", "-A");
  git(src, "commit", "-q", "--amend", "--no-edit");
  const c0x = git(src, "rev-parse", "HEAD");
  const c1 = commit(src, "site", { "core/site/deep/page.html": "v1" });
  const c2 = commit(src, "readme", { "README.md": "r1" });
  git(dir, "clone", "-q", "--bare", src, origin);
  git(dir, "clone", "-q", origin, vps);
  git(vps, "reset", "-q", "--hard", c0x);
  // Stand-ins. docker answers `manifest inspect <image>` like a registry that only has $PUBLISHED.
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "docker"),
    '#!/usr/bin/env bash\necho "docker $*" >> "$CALLS"\n[[ "$1 $2" == "manifest inspect" ]] && [[ " $PUBLISHED " == *" ${3##*:} "* ]]\n',
    { mode: 0o755 },
  );
  writeFileSync(path.join(dir, "calls.log"), "");
  return { dir, vps, bin, c0: c0x, c1, c2, calls: path.join(dir, "calls.log") };
}

function run(env, args = []) {
  const r = spawnSync("bash", [path.join(env.vps, "deploy/redeploy.sh"), ...args], {
    cwd: env.vps,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${env.bin}:${process.env.PATH}`,
      CALLS: env.calls,
      PUBLISHED: env.published ?? `site-${env.c1}`,
    },
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

test("--dry-run: the newest main commit, and the newest commit the site image is built from (not the same one here)", () =>
  withSetup((env) => {
    const r = run(env, ["--dry-run"]);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, new RegExp(`deploy/vps-deploy\\.sh --site-only ${env.c2} ${env.c1}`));
    assert.deepEqual(r.calls, [`docker manifest inspect ghcr.io/alisafari-it/asafarim-os:site-${env.c1}`]);
    assert.equal(r.head, env.c0, "a dry run changes nothing: the checkout stays where it was");
  }));

test("it deploys: brings the checkout to the newest commit, then runs the newest vps-deploy.sh --site-only with both shas", () =>
  withSetup((env) => {
    const r = run(env);
    assert.equal(r.status, 0, r.output);
    assert.equal(r.head, env.c2);
    assert.equal(r.calls.at(-1), `vps-deploy --site-only ${env.c2} ${env.c1} (HEAD ${env.c2})`);
  }));

test("a site image that is not published yet stops it, says why, and changes nothing (never an older image)", () =>
  withSetup((env) => {
    const r = run({ ...env, published: `site-${env.c0}` }); // an OLDER image exists; the newest does not
    assert.equal(r.status, 1);
    assert.match(r.output, /is not published \(yet\)/);
    assert.match(r.output, /'Site image' workflow/);
    assert.equal(r.head, env.c0);
    assert.ok(!r.calls.some((c) => c.startsWith("vps-deploy")), "nothing was deployed");
  }));

test("a commit that only changes something else does not move the site image", () =>
  withSetup((env) => {
    // c2 changed the README only: the site image is still c1's.
    const r = run(env, ["--dry-run"]);
    assert.match(r.output, new RegExp(`Newest site image from: ${env.c1}`));
    assert.doesNotMatch(r.output, new RegExp(`Newest site image from: ${env.c2}`));
  }));

test("anything but --dry-run is refused with the usage line", () =>
  withSetup((env) => {
    for (const args of [["--yes"], ["--dry-run", "x"]]) {
      const r = run(env, args);
      assert.equal(r.status, 2, r.output);
      assert.match(r.output, /usage: deploy\/redeploy\.sh \[--dry-run\]/);
    }
    assert.deepEqual(run(env, ["--yes"]).calls, [], "it asked the registry nothing");
  }));

test("it is valid bash, runs main() on one last line, and never prints a secret", () => {
  const r = spawnSync("bash", ["-n", path.join(root, "deploy", "redeploy.sh")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(script.trimEnd().split("\n").at(-1), 'main "$@"; exit $?');
  assert.doesNotMatch(script, /set -[a-z]*x/);
  assert.doesNotMatch(script, /\.env\.identity|age -d/);
});

test("its list of the site image's inputs is the one in .github/workflows/site-image.yml", () => {
  const workflow = readFileSync(path.join(root, ".github", "workflows", "site-image.yml"), "utf8");
  const push = /^ {2}push:\n {4}branches:[^\n]*\n {4}paths:\n((?: {6}(?:#[^\n]*|- "[^"]+")\n)+)/m.exec(workflow);
  assert.ok(push, "the workflow's push.paths block was not found: update this test with the workflow");
  const fromWorkflow = [...push[1].matchAll(/- "([^"]+)"/g)].map((m) => m[1]);
  const array = /SITE_IMAGE_PATHS=\(([^)]*)\)/.exec(script)?.[1] ?? "";
  const fromScript = [...array.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(fromScript, fromWorkflow);
});

test("pnpm redeploy is deploy/redeploy.sh", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.redeploy, "bash deploy/redeploy.sh");
});
