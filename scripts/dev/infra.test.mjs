/**
 * Regression test for the dev dependency build (asafarim-os#34).
 * Tests that workspaceBuildFilters() and uncoveredByFilters() correctly
 * cover all core services and apps, preventing "works locally, broken on a
 * clean checkout" incidents.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEV_SERVICES, APPS_FILTER, appPackages, uncoveredByFilters, workspaceBuildFilters } from "./infra.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixtureWith(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "infra-test-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    const parentDir = path.dirname(filePath);
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(filePath, content);
  }
  return dir;
}

test("workspaceBuildFilters includes ^... for every DEV_SERVICES", () => {
  const filters = workspaceBuildFilters(ROOT);
  for (const service of DEV_SERVICES) {
    assert.ok(filters.includes(`--filter=${service}^...`), `missing filter for ${service}`);
  }
});

test("workspaceBuildFilters includes ./apps/*^... when apps/ has packages", () => {
  const filters = workspaceBuildFilters(ROOT);
  const hasApps = appPackages(ROOT).length > 0;
  assert.equal(filters.includes(APPS_FILTER), hasApps);
});

test("uncoveredByFilters is empty when all core services and apps are covered", () => {
  const filters = workspaceBuildFilters(ROOT);
  const missing = uncoveredByFilters(filters, ROOT);
  assert.deepEqual(missing, [], `uncovered: ${missing.join(", ")}`);
});

test("uncoveredByFilters reports a missing core service filter", () => {
  const filters = workspaceBuildFilters(ROOT).filter((f) => !f.startsWith("--filter=@asafarim/identity"));
  const missing = uncoveredByFilters(filters, ROOT);
  assert.ok(missing.includes("@asafarim/identity"));
});

test("uncoveredByFilters reports all apps when APPS_FILTER is missing", () => {
  const filters = workspaceBuildFilters(ROOT).filter((f) => f !== APPS_FILTER);
  const missing = uncoveredByFilters(filters, ROOT);
  const apps = appPackages(ROOT);
  assert.equal(missing.length, apps.length);
  for (const app of apps) {
    assert.ok(missing.includes(`apps/${app}`));
  }
});

test("uncoveredByFilters fails on a fixture with an uncovered app", () => {
  const dir = fixtureWith({
    "apps/newapp/package.json": '{ "name": "@asafarim/newapp" }\n',
  });
  try {
    const filters = workspaceBuildFilters(ROOT); // real repo filters, no newapp
    const missing = uncoveredByFilters(filters, dir);
    assert.ok(missing.includes("apps/newapp"), `expected apps/newapp in uncovered: ${missing.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("this repository is covered (the real tree passes)", () => {
  const filters = workspaceBuildFilters(ROOT);
  const missing = uncoveredByFilters(filters, ROOT);
  assert.deepEqual(missing, [], `real tree has uncovered packages: ${missing.join(", ")}`);
});
