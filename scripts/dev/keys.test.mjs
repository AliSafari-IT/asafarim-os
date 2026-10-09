// The dev key helpers (OS-D1; P4.1 PR 4 added the bus keys).
//   node --test scripts/dev/keys.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { addMissingLines, upsertLines } from "./keys.mjs";

function withFile(text, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "keys-"));
  const file = path.join(dir, "x.env");
  writeFileSync(file, text);
  try {
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("upsertLines replaces a key the file has and appends the ones it lacks", () => {
  withFile("A=1\nB=2\n", (f) => {
    upsertLines(f, ["B=3", "C=4"]);
    assert.equal(readFileSync(f, "utf8"), "A=1\nB=3\nC=4\n");
  });
});

test("upsertLines copes with a file that has no trailing newline and keeps other keys that share a prefix", () => {
  withFile("CORE_API_NATS_URL=x\nCORE_API_NATS=y", (f) => {
    upsertLines(f, ["CORE_API_NATS_URL=z"]);
    assert.equal(readFileSync(f, "utf8"), "CORE_API_NATS_URL=z\nCORE_API_NATS=y\n");
  });
});

test("addMissingLines keeps what is there", () => {
  withFile("A=1\n", (f) => {
    assert.equal(addMissingLines(f, ["A=2", "B=3"]), true);
    assert.equal(readFileSync(f, "utf8"), "A=1\nB=3\n");
    assert.equal(addMissingLines(f, ["A=9"]), false);
  });
});
