#!/usr/bin/env node
/**
 * Proves no document content is baked into the docs app's build (#78): builds it (standalone, as the
 * image will be) and fails if any fixture's marker text turns up anywhere under `.next/`.
 * `--no-build` checks an existing `.next/`: apps/docs/Dockerfile runs it that way on the image's build (#83).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const APP = path.resolve(import.meta.dirname, "..");
const MARKER = /docs-fixture-marker: ([a-z0-9-]+)/g;

function files(dir) {
  return readdirSync(dir, { recursive: true })
    .map((n) => path.join(dir, n))
    .filter((p) => statSync(p).isFile());
}

const markers = new Set();
for (const f of files(path.join(APP, "fixtures"))) {
  for (const m of readFileSync(f, "utf8").matchAll(MARKER)) markers.add(m[0]);
}
if (markers.size === 0) {
  console.error("no fixture markers found: the check would prove nothing");
  process.exit(1);
}

if (!process.argv.includes("--no-build")) {
  const next = path.join(APP, "node_modules/next/dist/bin/next");
  const r = spawnSync(process.execPath, [next, "build"], {
    cwd: APP,
    stdio: "inherit",
    env: { ...process.env, BUILD_STANDALONE: "true" },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const found = [];
for (const f of files(path.join(APP, ".next"))) {
  if (f.includes(`${path.sep}cache${path.sep}`)) continue;
  const text = readFileSync(f).toString("latin1");
  for (const marker of markers) if (text.includes(marker)) found.push(`${path.relative(APP, f)}: ${marker}`);
}
if (found.length) {
  console.error(`document content found in the build:\n  ${found.join("\n  ")}`);
  process.exit(1);
}
console.log(`no document content in .next/ (${markers.size} fixture markers checked)`);
