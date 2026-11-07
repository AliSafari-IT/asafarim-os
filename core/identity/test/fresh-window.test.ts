import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// core/identity answers prompt=login from its own session when that session is younger than FRESH_LOGIN_SLACK_SECONDS.
// @asafarim/auth-runtime refuses a step-up window shorter than that (MIN_FRESH_MS), because a shorter one can loop: the
// provider reuses a login the app already finds too old. Neither package can import the other's source, so this reads both
// constants from source (the pattern of scripts/session-ttl.test.mjs) and fails if they drift apart.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/** The value of `const <name> = <integer literals joined by * or _>;`. Anything else throws, so a rewrite fails here. */
function value(source: string, name: string): number {
  const m = [...source.matchAll(new RegExp(`^(?:export )?const ${name}\\s*=\\s*([^;\\n]+);`, "gm"))];
  if (m.length !== 1) throw new Error(`expected one \`const ${name} = …;\`, found ${m.length}`);
  const expr = m[0]![1]!.trim();
  if (!/^\d[\d_]*(\s*\*\s*\d[\d_]*)*$/.test(expr))
    throw new Error(`${name} = ${expr}: only integer literals joined by * are understood`);
  return expr.split("*").reduce((n, part) => n * Number(part.trim().replaceAll("_", "")), 1);
}

describe("the step-up window floor matches identity's login reuse window", () => {
  const slack = value(read("core/identity/src/provider.ts"), "FRESH_LOGIN_SLACK_SECONDS");
  const floor = value(read("packages/auth-runtime/src/bounds.ts"), "MIN_FRESH_MS");

  it("MIN_FRESH_MS is FRESH_LOGIN_SLACK_SECONDS in milliseconds", () => {
    expect(slack).toBeGreaterThan(0);
    expect(floor, "change both together: auth-runtime's MIN_FRESH_MS and identity's FRESH_LOGIN_SLACK_SECONDS").toBe(
      slack * 1000,
    );
  });

  it("the reader refuses what it cannot evaluate", () => {
    expect(value("const A = 2 * 60;", "A")).toBe(120);
    expect(() => value("const A = f();", "A")).toThrow();
    expect(() => value("", "A")).toThrow();
  });
});
