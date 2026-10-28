/**
 * `test.echo`, the test-only connector: it answers its `text` (a templated field) back, and `note` (not
 * templated) with it. Registered in the process's registry by the tests only (`registerEcho`), never by
 * the app. What its next calls do is scripted with `echo.script`: a ConnectorError to throw, another
 * error, or a call that never answers.
 */
import { z } from "zod";
import { connectors, type Connector, type ConnectorContext, type ConnectorError } from "../lib/engine/connectors";
import { templatedText } from "../lib/workflow/templates";

type Step = { fail: ConnectorError } | { throw: Error } | "hang" | "bad-output";

export const echo = {
  /** What each next call does, in order; an empty script: answer. */
  script: [] as Step[],
  calls: [] as { ctx: Omit<ConnectorContext, "log" | "signal">; input: { text: string; note?: string } }[],
  reset() {
    this.script = [];
    this.calls = [];
  },
};

const Input = z.strictObject({ text: templatedText(500), note: z.string().max(100).optional() });
const Output = z.strictObject({ text: z.string(), note: z.string().optional() });

export const ECHO: Connector<z.infer<typeof Input>, z.infer<typeof Output>> = {
  type: "test.echo",
  input: Input,
  output: Output,
  timeoutMs: 50,
  simulate: (input) => ({ text: `(simulated) ${input.text}` }),
  async run(ctx, input) {
    const { log: _log, signal: _signal, ...rest } = ctx;
    echo.calls.push({ ctx: rest, input });
    const next = echo.script.shift();
    if (next === "hang") return new Promise<never>(() => undefined);
    if (next === "bad-output") return { text: 42 } as unknown as { text: string };
    if (next && "fail" in next) throw next.fail;
    if (next && "throw" in next) throw next.throw;
    return { text: input.text, ...(input.note ? { note: input.note } : {}) };
  },
};

export function registerEcho(): void {
  if (!connectors.get(ECHO.type)) connectors.register(ECHO);
}
