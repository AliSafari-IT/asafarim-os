import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APPS_FILTER, DEV_SERVICES, appPackages, uncoveredByFilters, workspaceBuildFilters } from "./infra.mjs";

const REAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A throwaway repo root whose apps/ holds the given package names (plus a stray file and a non-package dir). */
function fixture(apps) {
  const root = mkdtempSync(path.join(tmpdir(), "infra-"));
  mkdirSync(path.join(root, "apps"));
  writeFileSync(path.join(root, "apps", "README.md"), "not an app\n");
  mkdirSync(path.join(root, "apps", "scratch")); // a directory without a package.json
  for (const name of apps) {
    mkdirSync(path.join(root, "apps", name));
    writeFileSync(path.join(root, "apps", name, "package.json"), "{}\n");
  }
  return root;
}

function withFixture(apps, fn) {
  const root = fixture(apps);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("every started core service gets its dependencies built (^...)", () => {
  withFixture([], (root) => {
    const filters = workspaceBuildFilters(root);
    for (const service of DEV_SERVICES) assert.ok(filters.includes(`--filter=${service}^...`), service);
    assert.deepEqual(DEV_SERVICES, ["@asafarim/identity", "@asafarim/core-api", "@asafarim/dev-hub"]);
  });
});

test("no app package: no apps filter (a README or empty folder isn't an app)", () => {
  withFixture([], (root) => {
    assert.deepEqual(appPackages(root), []);
    assert.ok(!workspaceBuildFilters(root).includes(APPS_FILTER));
  });
});

test("an app package adds ./apps/*^...", () => {
  withFixture(["notes"], (root) => {
    assert.deepEqual(appPackages(root), ["notes"]);
    assert.ok(workspaceBuildFilters(root).includes("--filter=./apps/*^..."));
    assert.deepEqual(uncoveredByFilters(workspaceBuildFilters(root), root), []);
  });
});

test("a missing apps/ directory is no apps", () => {
  const root = mkdtempSync(path.join(tmpdir(), "infra-"));
  try {
    assert.deepEqual(appPackages(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FAILS when a new apps/<x> package isn't covered by the filters", () => {
  withFixture(["notes", "tasks"], (root) => {
    // The old, hand-listed shape: services only, no apps glob.
    const stale = DEV_SERVICES.map((s) => `--filter=${s}^...`);
    assert.deepEqual(uncoveredByFilters(stale, root), ["apps/notes", "apps/tasks"]);
  });
});

test("FAILS when a core service is dropped from the filters", () => {
  withFixture([], (root) => {
    const filters = workspaceBuildFilters(root).filter((f) => !f.includes("core-api"));
    assert.deepEqual(uncoveredByFilters(filters, root), ["@asafarim/core-api"]);
  });
});

test("the real tree is covered", () => {
  assert.deepEqual(uncoveredByFilters(workspaceBuildFilters(REAL_ROOT), REAL_ROOT), []);
  assert.ok(appPackages(REAL_ROOT).includes("notes"));
});
