/**
 * What a run knows while it executes: the trigger event's payload and the output of each step that
 * succeeded so far. Conditions read fields of it (lib/workflow/conditions.ts) and actions map it to
 * their request payload (lib/workflow/requests.ts).
 */
export interface RunContext {
  runId: string;
  trigger: Record<string, unknown>;
  /** By step key: only steps that succeeded. */
  steps: Record<string, { output: unknown }>;
}

/** `trigger.<a>[.<b>…]` or `steps.<key>.output[.<a>…]`: nothing else can be addressed. */
export const FIELD_PATH = /^(?:trigger(?:\.[A-Za-z0-9_-]+)+|steps\.[a-z][a-z0-9-]*\.output(?:\.[A-Za-z0-9_-]+)*)$/;

/** The step key a `steps.<key>.output…` path reads, or undefined for a `trigger.…` path. */
export function stepKeyOf(path: string): string | undefined {
  return path.startsWith("steps.") ? path.split(".")[1] : undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The value at `path`, or undefined when any part of it is missing. */
export function resolveField(ctx: RunContext, path: string): unknown {
  const [root, ...rest] = path.split(".");
  let value: unknown;
  if (root === "trigger") value = ctx.trigger;
  else if (root === "steps") {
    const [key, output, ...more] = rest;
    if (output !== "output" || key === undefined || !Object.hasOwn(ctx.steps, key)) return undefined;
    value = ctx.steps[key]!.output;
    rest.splice(0, rest.length, ...more);
  } else return undefined;
  for (const part of rest) {
    if (!isRecord(value) || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}
