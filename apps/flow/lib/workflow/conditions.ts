/**
 * A condition step's clauses, deliberately small: `equals`, `notEquals` and `contains` on one field
 * each, all of which must hold. No expression language.
 *
 * - `equals` / `notEquals`: strict equality of JSON scalars. A missing field equals nothing (so
 *   `notEquals` holds for it).
 * - `contains`: an array that has the value as an item, or a string that has it as a substring.
 *   Anything else (missing, a number, an object) contains nothing.
 */
import { resolveField, type RunContext } from "./context";
import type { Clause } from "./definition";

export function holds(clause: Clause, ctx: RunContext): boolean {
  const actual = resolveField(ctx, clause.field);
  switch (clause.op) {
    case "equals":
      return actual === clause.value;
    case "notEquals":
      return actual !== clause.value;
    case "contains":
      if (Array.isArray(actual)) return actual.some((item) => item === clause.value);
      if (typeof actual === "string" && typeof clause.value === "string") return actual.includes(clause.value);
      return false;
  }
}

/** Every clause holds, and the value each one read (the step's input, for the Run page). */
export function evaluate(
  all: readonly Clause[],
  ctx: RunContext,
): { passed: boolean; fields: Record<string, unknown> } {
  const fields: Record<string, unknown> = {};
  for (const c of all) fields[c.field] = resolveField(ctx, c.field) ?? null;
  return { passed: all.every((c) => holds(c, ctx)), fields };
}
