// An app's session must end when identity's does (#185). The app SDK can't
// import core/identity, so it keeps its own copy of identity's session
// lifetime. This test reads both constants from source and fails if they
// drift apart.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const IDENTITY = { file: "core/identity/src/auth-session.ts", name: "AUTH_SESSION_TTL_SECONDS" };
const APP_SDK = { file: "packages/app-sdk/src/auth.ts", name: "IDENTITY_SESSION_SECONDS" };

/**
 * The value of `export const <name> = <a> * <b> …;` in `source`: integer
 * literals (underscores allowed) joined by `*`. Anything else throws, so a
 * rewrite of the constant fails this test instead of passing it silently.
 */
function readSeconds(source, name) {
  const matches = [...source.matchAll(new RegExp(`^export const ${name}\\s*=\\s*([^;\\n]+);`, "gm"))];
  if (matches.length !== 1) throw new Error(`expected one \`export const ${name} = …;\`, found ${matches.length}`);
  const expr = matches[0][1].trim();
  if (!/^\d[\d_]*(\s*\*\s*\d[\d_]*)*$/.test(expr)) {
    throw new Error(`${name} = ${expr}: only integer literals joined by * are understood`);
  }
  return expr.split("*").reduce((n, part) => n * Number(part.trim().replaceAll("_", "")), 1);
}

const read = ({ file, name }) => readSeconds(readFileSync(path.join(root, file), "utf8"), name);

test("the app SDK's session lifetime equals identity's", () => {
  const identity = read(IDENTITY);
  const sdk = read(APP_SDK);
  assert.ok(identity > 0, `${IDENTITY.name} must be positive`);
  assert.equal(
    sdk,
    identity,
    `${APP_SDK.file} ${APP_SDK.name} (${sdk}s) differs from ${IDENTITY.file} ${IDENTITY.name} (${identity}s); change both`,
  );
});

test("readSeconds reads literals and products", () => {
  assert.equal(readSeconds("export const T = 43200;\n", "T"), 43200);
  assert.equal(readSeconds("export const T = 12 * 3600;\n", "T"), 43200);
  assert.equal(readSeconds("export const T = 2*6 * 60 * 60;", "T"), 43200);
  assert.equal(readSeconds("export const T = 43_200;", "T"), 43200);
});

test("readSeconds ignores other constants and names that only share a prefix", () => {
  const src = "export const T_MAX = 1;\nexport const T = 5 * 60;\nconst T2 = 9;\n";
  assert.equal(readSeconds(src, "T"), 300);
});

test("readSeconds refuses what it can't evaluate", () => {
  assert.throws(() => readSeconds("export const T = HOURS * 12;", "T"), /only integer literals/);
  assert.throws(() => readSeconds("export const T = Number(process.env.T);", "T"), /only integer literals/);
  assert.throws(() => readSeconds("const T = 1;", "T"), /found 0/);
  assert.throws(() => readSeconds("export const T = 1;\nexport const T = 2;", "T"), /found 2/);
});
