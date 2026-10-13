/**
 * The `platform` CLI.
 *
 *   pnpm platform sync [--root <dir>]        generate <dir>/generated/platform/ from every
 *                                            <dir>/apps/<id>/platform.app.json (default: this workspace)
 *   pnpm platform sync --check [--root <dir>] fail when generated/platform/ has drifted (CI)
 *   pnpm platform sync --check --against <dir> [--other-stack-sites <file>]
 *                                            compare the manifests in <dir>/apps/* with that
 *                                            checkout's hand-written wiring; read-only.
 *                                            Reads platform.app.json only (never executes app code).
 *                                            <file>: gateway sites of other stacks on the same edge,
 *                                            one per line (# comments allowed); listed, not drift
 *   pnpm platform manifest validate <file>   check one manifest (.json, or a .ts default export)
 *   pnpm platform manifest compile <file>    validate and write platform.app.json beside it
 *   pnpm platform boundaries                 fail if core/ or packages/ import from apps/
 *   pnpm platform app new <id> [--name "<Display name>"] [--root <dir>]
 *                                            write a minimal app to <dir>/apps/<id>/ (P7.1); installs nothing
 *   pnpm platform app compose <id|image-ref> --env prod|staging --out <file>
 *                                            write the compose file that runs an external app (#106); --help for more
 *   pnpm platform app install <id> [--env-out <file>]   install apps/<id> via core-api (P3.1)
 *   pnpm platform app install --image <ref> [--env-out <file>]
 *                                            install an app from another repository from its image (#87):
 *                                            the manifest comes from its org.asafarim.app.manifest label
 *   pnpm platform app activate|deactivate <id>          change its lifecycle state
 *   pnpm platform role grant|revoke <role> <subject>    an admin (un)grants an app's declared role
 */
import path from "node:path";
import { computeDrift, formatDrift } from "./against/drift.ts";
import { appCommand, roleCommand } from "./app.ts";
import { loadPlatformWiring, readSiteList } from "./against/load.ts";
import { boundariesCommand } from "./boundaries.ts";
import { compileCommand, validateCommand } from "./manifest.ts";
import { composeCommand } from "./compose.ts";
import { newAppCommand } from "./scaffold.ts";
import { findRepoRoot, sync } from "./sync.ts";

const USAGE = [
  "Usage:",
  "  platform sync [--check] [--root <dir>]",
  "  platform sync --check --against <dir> [--other-stack-sites <file>]",
  "  platform manifest validate <file>",
  "  platform manifest compile <file>",
  "  platform boundaries",
  '  platform app new <id> [--name "<Display name>"] [--root <dir>]   write a minimal app to apps/<id>',
  "  platform app compose <id|image-ref> --env prod|staging --out <file>   (--help for the options)",
  "  platform app install <id> [--env-out <file>]          an app in apps/<id>",
  "  platform app install --image <ref> [--env-out <file>]  an app from another repository, by image",
  "      (the explicit --image flag tells the two apart; the manifest is read from the image's",
  "      org.asafarim.app.manifest label, pulling it first if needed, and never by running it)",
  "  platform app activate|deactivate <id>",
  "  platform role grant|revoke <role> <subject>",
].join("\n");

/** pnpm runs the CLI from its package folder; INIT_CWD is where the user typed the command. */
const cwd = process.env.INIT_CWD ?? process.cwd();

type Result = { ok: boolean; lines: string[] };

async function syncCommand(args: string[]): Promise<Result | null> {
  let check = false;
  let against: string | undefined;
  let otherStackFile: string | undefined;
  let rootDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") check = true;
    else if (args[i] === "--against" && args[i + 1]) against = args[++i];
    else if (args[i] === "--other-stack-sites" && args[i + 1]) otherStackFile = args[++i];
    else if (args[i] === "--root" && args[i + 1]) rootDir = args[++i];
    else return null;
  }
  if (otherStackFile !== undefined && against === undefined) return null;
  if (rootDir !== undefined && against !== undefined) return null;
  if (against === undefined) return sync(rootDir ? path.resolve(cwd, rootDir) : findRepoRoot(cwd), { check });
  if (!check) return { ok: false, lines: ["--against only reports drift; use it with --check."] };
  const root = path.resolve(cwd, against);
  const otherStackSites = otherStackFile ? readSiteList(path.resolve(cwd, otherStackFile)) : [];
  const report = computeDrift(await loadPlatformWiring(root), { otherStackSites });
  return { ok: report.ok, lines: [`Drift report for ${root}`, "", ...formatDrift(report)] };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  let result: Result | null = null;

  if (command === "sync") result = await syncCommand(rest);
  else if (command === "manifest" && (rest[0] === "validate" || rest[0] === "compile") && rest.length === 2) {
    result = rest[0] === "validate" ? await validateCommand(rest[1]!, cwd) : await compileCommand(rest[1]!, cwd);
  } else if (command === "boundaries" && rest.length === 0) {
    result = boundariesCommand(findRepoRoot(cwd));
  } else if (command === "role") {
    result = await roleCommand(rest, findRepoRoot(cwd));
  } else if (command === "app" && rest[0] === "compose") {
    result = await composeCommand(rest.slice(1), findRepoRoot(cwd), cwd);
  } else if (command === "app" && rest[0] === "new") {
    result = newAppCommand(rest.slice(1), cwd, () => findRepoRoot(cwd));
  } else if (command === "app") {
    result = await appCommand(rest, findRepoRoot(cwd));
  }

  if (!result) {
    console.error(USAGE);
    return 2;
  }
  for (const line of result.lines) (result.ok ? console.log : console.error)(line);
  return result.ok ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
