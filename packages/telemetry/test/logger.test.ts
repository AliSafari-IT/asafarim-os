import { trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, describe, expect, it } from "vitest";
import { createLogger, type LogLevel } from "../src/index.ts";

const provider = new NodeTracerProvider();
provider.register();
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});

function capture() {
  const lines: { line: Record<string, unknown>; level: LogLevel }[] = [];
  const log = createLogger({
    app: "notes",
    write: (line, level) => lines.push({ line: JSON.parse(line) as Record<string, unknown>, level }),
  });
  return { log, lines };
}

describe("createLogger", () => {
  it("stamps lines written inside a span with its trace and span id", () => {
    const { log, lines } = capture();
    trace.getTracer("test").startActiveSpan("GET /api/notes", (span) => {
      log.info("notes listed", { count: 2 });
      expect(lines[0]?.line).toMatchObject({
        level: "info",
        app: "notes",
        msg: "notes listed",
        count: 2,
        trace_id: span.spanContext().traceId,
        span_id: span.spanContext().spanId,
      });
      span.end();
    });
    expect(lines[0]?.line.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("leaves the trace id out outside a span", () => {
    const { log, lines } = capture();
    log.warn("boot");
    expect(lines[0]?.level).toBe("warn");
    expect(lines[0]?.line).not.toHaveProperty("trace_id");
    expect(lines[0]?.line).not.toHaveProperty("span_id");
  });

  it("writes errors as name and message, without the stack", () => {
    const { log, lines } = capture();
    log.error("failed", { err: new TypeError("bad input") });
    expect(lines[0]?.line.err).toEqual({ name: "TypeError", message: "bad input" });
  });
});
