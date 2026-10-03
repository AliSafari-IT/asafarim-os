/**
 * The `platform` CLI.
 *
 *   pnpm platform sync                       generate generated/platform/ from the app manifests
 *   pnpm platform sync --check               fail when generated/platform/ has drifted (CI)
 *   pnpm platform manifest validate <file>   check one manifest (.json, or a .ts default export)
 *   pnpm platform manifest compile <file>    validate and write platform.app.json beside it
 */
import { compileCommand, validateCommand } from "./manifest.ts";
import { findRepoRoot, sync } from "./sync.ts";

const USAGE = [
  "Usage:",
  "  platform sync [--check]",
  "  platform manifest validate <file>",
  "  platform manifest compile <file>",
].join("\n");

/** pnpm runs the CLI from its package folder; INIT_CWD is where the user typed the command. */
const cwd = process.env.INIT_CWD ?? process.cwd();

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  let result: { ok: boolean; lines: string[] };

  if (command === "sync" && rest.every((arg) => arg === "--check")) {
    result = sync(findRepoRoot(cwd), { check: rest.includes("--check") });
  } else if (command === "manifest" && (rest[0] === "validate" || rest[0] === "compile") && rest.length === 2) {
    result = rest[0] === "validate" ? await validateCommand(rest[1]!, cwd) : await compileCommand(rest[1]!, cwd);
  } else {
    console.error(USAGE);
    return 2;
  }

  for (const line of result.lines) (result.ok ? console.log : console.error)(line);
  return result.ok ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
