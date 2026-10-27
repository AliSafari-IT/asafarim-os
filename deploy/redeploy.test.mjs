// deploy/redeploy.sh (the `pnpm redeploy` command): it works out the newest commit and the newest site and docs
// images by itself. The real script runs here against a throwaway origin repository and stand-ins for docker and for the
// repository's own deploy/vps-deploy.sh, which log what they are asked to do.
//
//   node --test deploy/redeploy.test.mjs          (needs bash and git)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * origin.git with four commits, and `vps`, a clone of it left at the FIRST commit (as a VPS that has not deployed
 * since):
 *   c0  adds the scripts (the real redeploy.sh and a stand-in vps-deploy.sh), a site file and a docs file
 *   c1  changes the site (core/site/deep/page.html)           ← the newest commit the site image is built from
 *   c2  changes the docs app (apps/docs/app/page.tsx)         ← the newest commit the docs image is built from
 *   c3  changes something else (README)                       ← the newest commit on main
 */
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "redeploy-"));
  const src = path.join(dir, "src");
  const origin = path.join(dir, "origin.git");
  const vps = path.join(dir, "vps");
  const bin = path.join(dir, "bin");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  commit(src, "scripts", {
    "deploy/redeploy.sh": script,
    "deploy/vps-deploy.sh": '#!/usr/bin/env bash\necho "vps-deploy $* (HEAD $(git rev-parse HEAD))" >> "$CALLS"\n',
    "core/site/index.html": "v0",
    "apps/docs/app/page.tsx": "d0",
    "README.md": "r0",
  });
  // As in the real repository, both scripts are executable files in git (and stay so in later commits).
  for (const file of ["deploy/redeploy.sh", "deploy/vps-deploy.sh"]) chmodSync(path.join(src, file), 0o755);
  git(src, "add", "-A");
  git(src, "commit", "-q", "--amend", "--no-edit");
  const c0 = git(src, "rev-parse", "HEAD");
  const c1 = commit(src, "site", { "core/site/deep/page.html": "v1" });
  const c2 = commit(src, "docs", { "apps/docs/app/page.tsx": "d1" });
  const c3 = commit(src, "readme", { "README.md": "r1" });
  // c4 changes identity: the newest commit the identity image is built from, and the newest on main.
  const c4 = commit(src, "identity", { "core/identity/src/x.ts": "i1" });
  // The other tests deploy as of c3, before identity changed: so main's head is c3 there, and c4 sits on a branch.
  git(src, "branch", "-q", "identity", c4);
  git(src, "reset", "-q", "--hard", c3);
  git(dir, "clone", "-q", "--bare", src, origin);
  git(dir, "clone", "-q", origin, vps);
  git(vps, "reset", "-q", "--hard", c0);
  // Stand-ins. docker answers `manifest inspect <image>` like a registry that only has $PUBLISHED.
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "docker"),
    [
      "#!/usr/bin/env bash",
      'if [[ "$1" == ps ]]; then printf \'%s\' "$IDENTITY_RUNNING"; exit "${DOCKER_PS_STATUS:-0}"; fi',
      'echo "docker $*" >> "$CALLS"',
      '[[ "$1 $2" == "manifest inspect" ]] && [[ " $PUBLISHED " == *" ${3##*:} "* ]]',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(path.join(dir, "calls.log"), "");
  return { dir, src, origin, vps, bin, c0, c1, c2, c3, c4, calls: path.join(dir, "calls.log") };
}

function run(env, args = []) {
  const r = spawnSync("bash", [path.join(env.vps, "deploy/redeploy.sh"), ...args], {
    cwd: env.vps,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${env.bin}:${process.env.PATH}`,
      CALLS: env.calls,
      PUBLISHED: env.published ?? `site-${env.c1} docs-${env.c2}`,
      IDENTITY_RUNNING: env.identityRunning ?? "",
      DOCKER_PS_STATUS: env.dockerPsStatus ?? "0",
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

test("--dry-run: the newest main commit, and the newest commits the site and docs images are built from (three different ones here)", () =>
  withSetup((env) => {
    const r = run(env, ["--dry-run"]);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, new RegExp(`deploy/vps-deploy\\.sh --site-only ${env.c3} ${env.c1} ${env.c2}`));
    assert.deepEqual(r.calls, [
      `docker manifest inspect ghcr.io/alisafari-it/asafarim-os:site-${env.c1}`,
      `docker manifest inspect ghcr.io/alisafari-it/asafarim-os:docs-${env.c2}`,
    ]);
    assert.equal(r.head, env.c0, "a dry run changes nothing: the checkout stays where it was");
  }));

test("it deploys: brings the checkout to the newest commit, then runs the newest vps-deploy.sh --site-only with the three shas", () =>
  withSetup((env) => {
    const r = run(env);
    assert.equal(r.status, 0, r.output);
    assert.equal(r.head, env.c3);
    assert.equal(r.calls.at(-1), `vps-deploy --site-only ${env.c3} ${env.c1} ${env.c2} (HEAD ${env.c3})`);
  }));

test("a site image that is not published yet stops it, says why, and changes nothing (never an older image)", () =>
  withSetup((env) => {
    const r = run({ ...env, published: `site-${env.c0} docs-${env.c2}` }); // an OLDER site image exists; the newest does not
    assert.equal(r.status, 3, "exit code 3 is the one the Deploy workflow waits out");
    assert.match(r.output, /is not published \(yet\)/);
    assert.match(r.output, /'Site image' workflow/);
    assert.equal(r.head, env.c0);
    assert.ok(!r.calls.some((c) => c.startsWith("vps-deploy")), "nothing was deployed");
  }));

test("a docs image that is not published yet stops it too, naming the 'Docs image' workflow (#83)", () =>
  withSetup((env) => {
    const r = run({ ...env, published: `site-${env.c1} docs-${env.c0}` });
    assert.equal(r.status, 3);
    assert.match(r.output, new RegExp(`docs-${env.c2} is not published \\(yet\\)`));
    assert.match(r.output, /'Docs image' workflow/);
    assert.equal(r.head, env.c0);
    assert.ok(!r.calls.some((c) => c.startsWith("vps-deploy")), "nothing was deployed");
  }));

test("a commit that only changes something else moves neither image; a docs change does not move the site image", () =>
  withSetup((env) => {
    // c3 changed the README only, c2 the docs app only: the site image is still c1's, the docs image c2's.
    const r = run(env, ["--dry-run"]);
    assert.match(r.output, new RegExp(`Newest site image from: ${env.c1}`));
    assert.match(r.output, new RegExp(`Newest docs image from: ${env.c2}`));
    assert.doesNotMatch(r.output, new RegExp(`Newest (site|docs) image from: ${env.c3}`));
  }));

test("anything but [--dry-run] [<full sha>] is refused with the usage line", () =>
  withSetup((env) => {
    for (const args of [
      ["--yes"],
      ["--dry-run", "x"],
      [env.c1.slice(0, 12)],
      [env.c1.toUpperCase()],
      [env.c1, "--dry-run"],
      ["--dry-run", env.c1, env.c2],
    ]) {
      const r = run(env, args);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.output}`);
      assert.match(r.output, /usage: deploy\/redeploy\.sh \[--with-identity\] \[--dry-run\] \[<commit>\]/);
    }
    assert.deepEqual(run(env, ["--yes"]).calls, [], "it asked the registry nothing");
  }));

test("<commit>: the newest images AS OF that commit, not of main's head", () =>
  withSetup((env) => {
    // At c1 the docs app had not changed yet: its image is still c0's.
    const r = run({ ...env, published: `site-${env.c1} docs-${env.c0}` }, ["--dry-run", env.c1]);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, new RegExp(`Commit to deploy: +${env.c1}`));
    assert.match(r.output, new RegExp(`deploy/vps-deploy\\.sh --site-only ${env.c1} ${env.c1} ${env.c0}`));
    assert.equal(r.head, env.c0, "a dry run changes nothing");
  }));

test("<commit>: deploys that commit, not the newest one", () =>
  withSetup((env) => {
    const r = run(env, [env.c2]);
    assert.equal(r.status, 0, r.output);
    assert.equal(r.head, env.c2);
    assert.equal(r.calls.at(-1), `vps-deploy --site-only ${env.c2} ${env.c1} ${env.c2} (HEAD ${env.c2})`);
  }));

test("<commit> that is not on origin/main, or not in the repository at all, is refused and changes nothing", () =>
  withSetup((env) => {
    git(env.vps, "checkout", "-q", "-b", "side");
    const side = commit(env.vps, "side", { "core/site/x.html": "x" });
    git(env.vps, "checkout", "-q", "--detach", env.c0);
    for (const [sha, why] of [
      [side, /is not on origin\/main/],
      ["0".repeat(40), /is not in this repository/],
    ]) {
      const r = run(env, [sha]);
      assert.equal(r.status, 1, r.output);
      assert.match(r.output, why);
      assert.equal(r.head, env.c0);
      assert.ok(!r.calls.some((c) => c.startsWith("vps-deploy")), "nothing was deployed");
    }
  }));

/** Move origin's main to c4 (identity changed), so the newest commit has an identity image to look for. */
function withIdentityCommit(env) {
  git(env.src, "push", "-q", "--force", env.origin, `${env.c4}:refs/heads/main`);
  return { ...env, published: `site-${env.c1} docs-${env.c2} identity-${env.c4}` };
}

test("identity running here: the full deploy, with the newest identity image, so id.asafarim.site stays on the edge", () =>
  withSetup((env) => {
    const e = { ...withIdentityCommit(env), identityRunning: "abc123\n" };
    const dry = run(e, ["--dry-run"]);
    assert.equal(dry.status, 0, dry.output);
    assert.match(dry.output, new RegExp(`Newest identity image from: ${env.c4}`));
    assert.match(dry.output, new RegExp(`deploy/vps-deploy\\.sh ${env.c4} ${env.c4} ${env.c1} ${env.c2}$`, "m"));
    assert.ok(dry.calls.includes(`docker manifest inspect ghcr.io/alisafari-it/asafarim-os:identity-${env.c4}`));
    const r = run(e);
    assert.equal(r.status, 0, r.output);
    assert.equal(r.calls.at(-1), `vps-deploy ${env.c4} ${env.c4} ${env.c1} ${env.c2} (HEAD ${env.c4})`);
    assert.doesNotMatch(r.calls.at(-1), /--site-only/);
  }));

test("--with-identity: the full deploy even before identity runs", () =>
  withSetup((env) => {
    const r = run(withIdentityCommit(env), ["--with-identity"]);
    assert.equal(r.status, 0, r.output);
    assert.equal(r.calls.at(-1), `vps-deploy ${env.c4} ${env.c4} ${env.c1} ${env.c2} (HEAD ${env.c4})`);
  }));

test("identity not running and no --with-identity: site-only, and identity is never started", () =>
  withSetup((env) => {
    const r = run(withIdentityCommit(env));
    assert.equal(r.status, 0, r.output);
    assert.equal(r.calls.at(-1), `vps-deploy --site-only ${env.c4} ${env.c1} ${env.c2} (HEAD ${env.c4})`);
    assert.ok(!r.calls.some((c) => c.includes(":identity-")), "no identity image was even looked up");
  }));

test("identity running but its newest image not published yet: exit code 3, nothing changed", () =>
  withSetup((env) => {
    const e = { ...withIdentityCommit(env), identityRunning: "abc123", published: `site-${env.c1} docs-${env.c2}` };
    const r = run(e);
    assert.equal(r.status, 3, r.output);
    assert.match(r.output, new RegExp(`identity-${env.c4} is not published \\(yet\\)`));
    assert.match(r.output, /'Identity image' workflow/);
    assert.equal(r.head, env.c0);
    assert.ok(!r.calls.some((c) => c.startsWith("vps-deploy")), "nothing was deployed");
  }));

test("if it cannot tell whether identity runs, it stops and changes nothing (never a site-only guess)", () =>
  withSetup((env) => {
    const r = run({ ...env, dockerPsStatus: "1" });
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /could not list this host's containers/);
    assert.equal(r.head, env.c0);
    assert.ok(!r.calls.some((c) => c.startsWith("vps-deploy")));
  }));

/** c5 adds core-api's encrypted env and c6 changes core-api, on top of c4: main's head is c6. */
function withCoreApi(env) {
  git(env.src, "checkout", "-q", "identity");
  const c5 = commit(env.src, "core-api env", { "core/core-api/.env.production.age": "stand-in ciphertext" });
  const c6 = commit(env.src, "core-api", { "core/core-api/src/x.ts": "k1" });
  git(env.src, "push", "-q", "--force", env.origin, `${c6}:refs/heads/main`);
  return { ...env, c5, c6, published: `site-${env.c1} docs-${env.c2} identity-${env.c4} core-api-${c6}` };
}

test("core-api's env committed and identity running: the full deploy with the newest core-api image as the fifth sha", () =>
  withSetup((env) => {
    const e = { ...withCoreApi(env), identityRunning: "abc123" };
    const r = run(e);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, new RegExp(`Newest core-api image from: ${e.c6}`));
    assert.ok(r.calls.includes(`docker manifest inspect ghcr.io/alisafari-it/asafarim-os:core-api-${e.c6}`));
    assert.equal(r.calls.at(-1), `vps-deploy ${e.c6} ${env.c4} ${env.c1} ${env.c2} ${e.c6} (HEAD ${e.c6})`);
  }));

/** The Admin console (#175): c7 adds its encrypted env and c8 changes it, on top of the core-api commits. */
function withAdmin(env) {
  const base = withCoreApi(env);
  const c7 = commit(env.src, "admin env", { "core/admin/.env.production.age": "stand-in ciphertext" });
  const c8 = commit(env.src, "admin", { "core/admin/app/x.ts": "k1" });
  git(env.src, "push", "-q", "--force", env.origin, `${c8}:refs/heads/main`);
  return { ...base, c7, c8, published: `${base.published} admin-${c8}` };
}

test("the Admin console's env committed next to core-api: its newest image is checked and passed as the sixth sha", () =>
  withSetup((env) => {
    const e = { ...withAdmin(env), identityRunning: "abc123" };
    const r = run(e);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, new RegExp(`Newest admin image from: ${e.c8}`));
    assert.ok(r.calls.includes(`docker manifest inspect ghcr.io/alisafari-it/asafarim-os:admin-${e.c8}`));
    assert.equal(r.calls.at(-1), `vps-deploy ${e.c8} ${env.c4} ${env.c1} ${env.c2} ${e.c6} ${e.c8} (HEAD ${e.c8})`);
  }));

test("the Admin console's newest image not published yet: exit code 3, naming the 'Admin image' workflow", () =>
  withSetup((env) => {
    const base = withAdmin(env);
    const r = run({ ...base, identityRunning: "abc123", published: base.published.replace(` admin-${base.c8}`, "") });
    assert.equal(r.status, 3, r.output);
    assert.match(r.output, new RegExp(`admin-${base.c8} is not published \\(yet\\)`));
    assert.match(r.output, /'Admin image' workflow/);
    assert.ok(!r.calls.some((c) => c.startsWith("vps-deploy")));
  }));

test("core-api's env committed without the Admin console's: no admin image is looked up, five shas as before", () =>
  withSetup((env) => {
    const e = { ...withCoreApi(env), identityRunning: "abc123" };
    const r = run(e);
    assert.equal(r.status, 0, r.output);
    assert.ok(!r.calls.some((c) => c.includes(":admin-")));
    assert.equal(r.calls.at(-1), `vps-deploy ${e.c6} ${env.c4} ${env.c1} ${env.c2} ${e.c6} (HEAD ${e.c6})`);
  }));

test("core-api's newest image not published yet: exit code 3, naming the 'Core API image' workflow, nothing changed", () =>
  withSetup((env) => {
    const base = withCoreApi(env);
    const e = { ...base, identityRunning: "abc123", published: `site-${env.c1} docs-${env.c2} identity-${env.c4}` };
    const r = run(e);
    assert.equal(r.status, 3, r.output);
    assert.match(r.output, new RegExp(`core-api-${base.c6} is not published \\(yet\\)`));
    assert.match(r.output, /'Core API image' workflow/);
    assert.equal(r.head, env.c0);
  }));

test("site-only (identity not running): core-api is never looked up, even with its env committed", () =>
  withSetup((env) => {
    const e = withCoreApi(env);
    const r = run(e);
    assert.equal(r.status, 0, r.output);
    assert.match(r.calls.at(-1), /^vps-deploy --site-only /);
    assert.ok(!r.calls.some((c) => c.includes(":core-api-")));
  }));

test("identity running, no core-api env in the commit: four shas, as before", () =>
  withSetup((env) => {
    const r = run({ ...withIdentityCommit(env), identityRunning: "abc123" });
    assert.equal(r.status, 0, r.output);
    assert.equal(r.calls.at(-1), `vps-deploy ${env.c4} ${env.c4} ${env.c1} ${env.c2} (HEAD ${env.c4})`);
    assert.ok(!r.calls.some((c) => c.includes(":core-api-")));
  }));

/** Flow: c9 adds its encrypted env and c10 changes it, on top of the core-api commits (and the Admin console's if asked). */
function withFlow(env, { admin = false } = {}) {
  const base = admin ? withAdmin(env) : withCoreApi(env);
  const c9 = commit(env.src, "flow env", { "apps/flow/.env.production.age": "stand-in ciphertext" });
  const c10 = commit(env.src, "flow", { "apps/flow/app/x.ts": "f1" });
  git(env.src, "push", "-q", "--force", env.origin, `${c10}:refs/heads/main`);
  return { ...base, c9, c10, published: `${base.published} flow-${c10}` };
}

test("Flow's env committed next to core-api: its newest image is checked and passed as the seventh sha (the sixth a placeholder)", () =>
  withSetup((env) => {
    const e = { ...withFlow(env), identityRunning: "abc123" };
    const r = run(e);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, new RegExp(`Newest flow image from: ${e.c10}`));
    assert.ok(r.calls.includes(`docker manifest inspect ghcr.io/alisafari-it/asafarim-os:flow-${e.c10}`));
    assert.ok(!r.calls.some((c) => c.includes(":admin-")), "no Admin console: no admin image is looked up");
    assert.equal(
      r.calls.at(-1),
      `vps-deploy ${e.c10} ${env.c4} ${env.c1} ${env.c2} ${e.c6} ${e.c10} ${e.c10} (HEAD ${e.c10})`,
    );
  }));

test("Flow and the Admin console: the admin image is the sixth sha, Flow's the seventh", () =>
  withSetup((env) => {
    const e = { ...withFlow(env, { admin: true }), identityRunning: "abc123" };
    const r = run(e);
    assert.equal(r.status, 0, r.output);
    assert.equal(
      r.calls.at(-1),
      `vps-deploy ${e.c10} ${env.c4} ${env.c1} ${env.c2} ${e.c6} ${e.c8} ${e.c10} (HEAD ${e.c10})`,
    );
  }));

test("Flow's newest image not published yet: exit code 3, naming the 'Flow image' workflow, nothing changed", () =>
  withSetup((env) => {
    const base = withFlow(env);
    const r = run({ ...base, identityRunning: "abc123", published: base.published.replace(` flow-${base.c10}`, "") });
    assert.equal(r.status, 3, r.output);
    assert.match(r.output, new RegExp(`flow-${base.c10} is not published \\(yet\\)`));
    assert.match(r.output, /'Flow image' workflow/);
    assert.ok(!r.calls.some((c) => c.startsWith("vps-deploy")));
    assert.equal(r.head, env.c0);
  }));

test("without apps/flow/.env.production.age: no flow image is looked up, and the shas are those of before", () =>
  withSetup((env) => {
    const e = { ...withAdmin(env), identityRunning: "abc123" };
    const r = run(e);
    assert.equal(r.status, 0, r.output);
    assert.ok(!r.calls.some((c) => c.includes(":flow-")));
    assert.doesNotMatch(r.output, /Flow is part of this deploy/);
    assert.equal(r.calls.at(-1), `vps-deploy ${e.c8} ${env.c4} ${env.c1} ${env.c2} ${e.c6} ${e.c8} (HEAD ${e.c8})`);
  }));

test("site-only (identity not running): Flow is never looked up, even with its env committed", () =>
  withSetup((env) => {
    const r = run(withFlow(env));
    assert.equal(r.status, 0, r.output);
    assert.match(r.calls.at(-1), /^vps-deploy --site-only /);
    assert.ok(!r.calls.some((c) => c.includes(":flow-")));
  }));

test("it is valid bash, runs main() on one last line, and never prints a secret", () => {
  const r = spawnSync("bash", ["-n", path.join(root, "deploy", "redeploy.sh")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(script.trimEnd().split("\n").at(-1), 'main "$@"; exit $?');
  assert.doesNotMatch(script, /set -[a-z]*x/);
  assert.doesNotMatch(script, /\.env\.identity|age -d/);
});

for (const [name, variable] of [
  ["site", "SITE_IMAGE_PATHS"],
  ["docs", "DOCS_IMAGE_PATHS"],
  ["identity", "IDENTITY_IMAGE_PATHS"],
  ["core-api", "CORE_API_IMAGE_PATHS"],
  ["admin", "ADMIN_IMAGE_PATHS"],
  ["flow", "FLOW_IMAGE_PATHS"],
]) {
  test(`its list of the ${name} image's inputs is the one in .github/workflows/${name}-image.yml`, () => {
    const workflow = readFileSync(path.join(root, ".github", "workflows", `${name}-image.yml`), "utf8");
    const pathsOf = (event) =>
      new RegExp(
        `^ {2}${event}:\\n(?: {4}branches:[^\\n]*\\n)? {4}paths:\\n((?: {6}(?:#[^\\n]*|- "[^"]+")\\n)+)`,
        "m",
      ).exec(workflow);
    const push = pathsOf("push");
    assert.ok(push, "the workflow's push.paths block was not found: update this test with the workflow");
    const fromWorkflow = [...push[1].matchAll(/- "([^"]+)"/g)].map((m) => m[1]);
    const array = new RegExp(`${variable}=\\(([^)]*)\\)`).exec(script)?.[1] ?? "";
    const fromScript = [...array.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(fromScript, fromWorkflow);
    const pr = pathsOf("pull_request");
    assert.ok(pr, "the workflow's pull_request.paths block was not found");
    assert.deepEqual(
      [...pr[1].matchAll(/- "([^"]+)"/g)].map((m) => m[1]),
      fromWorkflow,
    );
  });
}

test("pnpm redeploy is deploy/redeploy.sh", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.redeploy, "bash deploy/redeploy.sh");
});
