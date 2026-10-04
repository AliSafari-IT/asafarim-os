import assert from "node:assert/strict";
import { test } from "node:test";
import { isSensitivePlaintext } from "./check-env-safety.mjs";

test("decrypted env files, private keys and .dev/ are sensitive", () => {
  for (const file of [
    ".env",
    ".env.development",
    ".env.production",
    "core/identity/.env.production",
    "apps\\notes\\.env.local",
    ".age/key.txt",
    "core/identity/.age/key.txt",
    ".dev/identity.env",
    ".dev/clients.json",
  ]) {
    assert.equal(isSensitivePlaintext(file), true, file);
  }
});

test("encrypted files, examples, templates and the public key are not", () => {
  for (const file of [
    ".env.development.age",
    "core/identity/.env.production.age",
    ".env.example",
    ".env.development.example",
    "core/identity/.env.production.example",
    ".env.template",
    ".age/key.pub",
    "envage.config.json",
    "scripts/dev/keys.mjs",
    "src/env.ts",
  ]) {
    assert.equal(isSensitivePlaintext(file), false, file);
  }
});
