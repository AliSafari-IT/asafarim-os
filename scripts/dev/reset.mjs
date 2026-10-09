#!/usr/bin/env node
/**
 * `pnpm dev:reset` (OS-D1, #26): drop the LOCAL dev databases, Redis data and the
 * NATS JetStream store (the compose.dev.yml volumes), so the next `pnpm dev` starts clean. Asks
 * first; nothing happens unless you type "reset" (or pass --yes, e.g. in CI).
 * `--keys` also deletes the dev keys in .dev/. Never touches anything else.
 */
import { rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { bold, compose, dim, red, requireDocker } from "./infra.mjs";
import { DEV_DIR } from "./keys.mjs";

const yes = process.argv.includes("--yes");
const keys = process.argv.includes("--keys");

requireDocker();
console.log(`${bold(red("This deletes the local dev data:"))} the asafarim-os-dev Postgres, Redis and NATS volumes${keys ? " and the dev keys in .dev/" : ""}.
${dim("Only the local compose.dev.yml stack; nothing remote.")}`);

if (!yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Type ${bold("reset")} to continue (anything else cancels): `)).trim();
  rl.close();
  if (answer !== "reset") {
    console.log("Cancelled. Nothing was deleted.");
    process.exit(0);
  }
}

compose("down", "--volumes", "--remove-orphans");
if (keys) rmSync(DEV_DIR, { recursive: true, force: true });
console.log(`Done. Run ${bold("pnpm dev")} to start again.`);
