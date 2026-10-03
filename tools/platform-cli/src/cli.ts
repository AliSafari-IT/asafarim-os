/**
 * The `platform` CLI.
 *
 *   pnpm platform sync            generate generated/platform/ from the app manifests
 *   pnpm platform sync --check    fail when generated/platform/ has drifted (CI)
 */
import { findRepoRoot, sync } from "./sync.ts";

const USAGE = "Usage: platform sync [--check]";

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command !== "sync" || rest.some((arg) => arg !== "--check")) {
    console.error(USAGE);
    return 2;
  }
  const result = sync(findRepoRoot(process.env.INIT_CWD ?? process.cwd()), { check: rest.includes("--check") });
  for (const line of result.lines) (result.ok ? console.log : console.error)(line);
  return result.ok ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
