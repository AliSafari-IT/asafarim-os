/** Test helpers for the external-app install (#87): a fake docker CLI, and the fixture app's manifest. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import type { Docker, DockerResult } from "./image.ts";

export const FIXTURE_MANIFEST = readFileSync(
  path.resolve(import.meta.dirname, "../fixtures/external-app/platform.app.json"),
  "utf8",
);

/** A fake docker CLI: images by reference (their labels), and what a pull would bring. */
export function fakeDocker(opts: {
  local?: Record<string, Record<string, string> | null>;
  pullable?: Record<string, Record<string, string> | null>;
}): Docker & { calls: string[][] } {
  const local = { ...opts.local };
  const calls: string[][] = [];
  const ok = (stdout = ""): DockerResult => ({ status: 0, stdout, stderr: "" });
  const run = vi.fn((args: string[]): DockerResult => {
    calls.push(args);
    const ref = args.at(-1)!;
    if (args[0] === "image" && args[1] === "inspect") {
      if (!(ref in local)) return { status: 1, stdout: "", stderr: `Error: No such image: ${ref}\n` };
      return ok(`${JSON.stringify(local[ref])}\n`);
    }
    if (args[0] === "pull") {
      if (!opts.pullable || !(ref in opts.pullable)) {
        return { status: 1, stdout: "", stderr: `Error response from daemon: pull access denied for ${ref}\n` };
      }
      local[ref] = opts.pullable[ref]!;
      return ok();
    }
    return { status: 2, stdout: "", stderr: "unexpected docker call" };
  });
  return Object.assign(run, { calls });
}
