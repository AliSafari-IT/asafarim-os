/**
 * Regression test for the dev dependency build (asafarim-os#34): the turbo filters
 * buildWorkspaceDependencies() runs must cover every core service `pnpm dev` starts and every
 * package under apps/, or a fresh clone breaks while a warm checkout still works (#31, #33).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { APPS_FILTER, DEV_SERVICES, appPackages, uncoveredByFilters, workspaceBuildFilters } from "./infra.mjs";
import { ROOT } from "./keys.mjs";

const fixtures = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temporary repo root with the given files (path → content). */
function fixtureWith(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "infra-test-"));
  fixtures.push(dir);
  for (const [name, content] of Object.entries(files)) addFile(dir, name, content);
  return dir;
}

function addFile(root, name, content) {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const pkg = (name) => `${JSON.stringify({ name })}\n`;

test("the filters build the dependencies of every core service pnpm dev starts", () => {
  assert.deepEqual(DEV_SERVICES, ["@asafarim/identity", "@asafarim/core-api", "@asafarim/dev-hub"]);
  const filters = workspaceBuildFilters(fixtureWith());
  for (const service of DEV_SERVICES) {
    assert.ok(filters.includes(`--filter=${service}^...`), `no filter for ${service}: ${filters.join(" ")}`);
  }
});

test("the filters include ./apps/*^... when apps/ contains a package", () => {
  const root = fixtureWith({ "apps/notes/package.json": pkg("@asafarim/notes") });
  assert.deepEqual(appPackages(root), ["notes"]);
  assert.ok(workspaceBuildFilters(root).includes(APPS_FILTER));
  assert.deepEqual(uncoveredByFilters(workspaceBuildFilters(root), root), []);
});

test("the filters leave out ./apps/*^... when apps/ has no package", () => {
  assert.ok(!workspaceBuildFilters(fixtureWith()).includes(APPS_FILTER), "no apps/ at all");
  const root = fixtureWith({ "apps/README.md": "# apps\n", "apps/docs-assets/logo.svg": "<svg/>\n" });
  assert.deepEqual(appPackages(root), []);
  assert.ok(!workspaceBuildFilters(root).includes(APPS_FILTER), "apps/ without a package.json");
});

test("a new apps/<x> package the filters don't cover is reported", () => {
  const root = fixtureWith({ "apps/README.md": "# apps\n" });
  const filters = workspaceBuildFilters(root); // computed while apps/ had no package
  addFile(root, "apps/newapp/package.json", pkg("@asafarim/newapp"));
  assert.deepEqual(uncoveredByFilters(filters, root), ["apps/newapp"]);
});

test("a core service missing from the filters is reported", () => {
  const root = fixtureWith({ "apps/notes/package.json": pkg("@asafarim/notes") });
  const filters = workspaceBuildFilters(root).filter((f) => f !== "--filter=@asafarim/identity^...");
  assert.deepEqual(uncoveredByFilters(filters, root), ["@asafarim/identity"]);
});

test("this repository: every app and core service is covered", () => {
  const apps = appPackages(ROOT);
  assert.ok(apps.length > 0, `found no app package under ${path.join(ROOT, "apps")}`);
  const filters = workspaceBuildFilters(ROOT);
  assert.ok(filters.includes(APPS_FILTER));
  assert.deepEqual(uncoveredByFilters(filters, ROOT), []);
});
