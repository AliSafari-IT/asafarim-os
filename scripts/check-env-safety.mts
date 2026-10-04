#!/usr/bin/env node
/**
 * Safety check: ensure no decrypted .env files are committed to git.
 * Run this as a pre-commit hook or manually via `pnpm env:check`.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const EXTENSIONS = [".env", ".env.local", ".env.development", ".env.production", ".env.root"];

// Check if any .env files (not .age encrypted) are tracked by git
const trackedEnvFiles: string[] = [];
for (const ext of EXTENSIONS) {
  try {
    const output = execSync(`git ls-files "*${ext}"`, { cwd: ROOT, encoding: "utf-8" });
    if (output.trim()) {
      trackedEnvFiles.push(...output.trim().split("\n"));
    }
  } catch {
    // git ls-files fails if not in git repo or no matches
  }
}

if (trackedEnvFiles.length > 0) {
  console.error("❌ Security error: Decrypted .env files are tracked by git:");
  for (const file of trackedEnvFiles) {
    console.error(`   - ${file}`);
  }
  console.error("\nPlease:");
  console.error("  1. Remove these files from git: git rm --cached <file>");
  console.error("  2. Ensure they are in .gitignore");
  console.error("  3. Commit the changes");
  process.exit(1);
}

// Check if .age/key.txt is tracked
try {
  const keyTracked = execSync("git ls-files .age/key.txt", { cwd: ROOT, encoding: "utf-8" });
  if (keyTracked.trim()) {
    console.error("❌ Security error: Private key .age/key.txt is tracked by git!");
    console.error("Please remove it: git rm --cached .age/key.txt");
    process.exit(1);
  }
} catch {
  // Not tracked or doesn't exist
}

console.log("✅ Environment safety check passed: no decrypted .env files or private keys tracked");
