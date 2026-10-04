#!/usr/bin/env node
/**
 * `pnpm env:check`: secrets never reach git as plaintext.
 *
 * Fails when git tracks or stages a decrypted env file, an age private key, or anything
 * under .dev/ (pnpm dev:keys output), or when the committed public age key is missing.
 * Encrypted `.env*.age` files and `.example` / `.template` files are fine.
 *
 * Dependency-free on purpose: CI runs it before anything is built.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** True for a path that must never be committed (posix or Windows separators). */
export function isSensitivePlaintext(file) {
  const normalized = file.replaceAll("\\", "/");
  const base = path.posix.basename(normalized);

  if (normalized === ".dev" || normalized.startsWith(".dev/")) return true;
  if (normalized.startsWith(".age/") && normalized !== ".age/key.pub") return true;
  if (base === "key.txt" && normalized.includes(".age/")) return true;

  if (!base.startsWith(".env") || base.endsWith(".age")) return false;
  if (base.endsWith(".example") || base.endsWith(".template")) return false;
  return true;
}

function gitFiles(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

export function checkEnvSafety(root) {
  const failures = [];
  const config = JSON.parse(readFileSync(path.join(root, "envage.config.json"), "utf8"));
  const keyPub = config.keyPubFile ?? ".age/key.pub";
  if (!existsSync(path.join(root, keyPub))) {
    failures.push(`The committed public age key is missing (${keyPub}).`);
  }

  const tracked = gitFiles(root, ["ls-files"]).filter(isSensitivePlaintext);
  if (tracked.length > 0) failures.push(`Sensitive plaintext is tracked: ${tracked.join(", ")}`);

  const staged = gitFiles(root, ["diff", "--cached", "--name-only"]).filter(isSensitivePlaintext);
  if (staged.length > 0) failures.push(`Sensitive plaintext is staged: ${staged.join(", ")}`);

  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = checkEnvSafety(path.resolve(import.meta.dirname, ".."));
  if (failures.length > 0) {
    for (const failure of failures) console.error(`error: ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("Environment safety checks passed.");
  }
}
