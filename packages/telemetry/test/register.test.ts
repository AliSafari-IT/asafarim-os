import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { metrics, SpanKind, trace } from "@opentelemetry/api";
import { afterAll, describe, expect, it } from "vitest";
import { registerTelemetry } from "../src/index.ts";

afterAll(() => {
  trace.disable();
  metrics.disable();
});

describe("registerTelemetry", () => {
  it("is a no-op without OTEL_EXPORTER_OTLP_ENDPOINT", async () => {
    const telemetry = registerTelemetry({ appId: "notes", version: "0.1.0", env: {} });
    expect(telemetry.enabled).toBe(false);
    const span = trace.getTracer("test").startSpan("GET /api/notes");
    expect(span.isRecording()).toBe(false);
    span.end();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
  });

  it("does not throw when the collector is unreachable", async () => {
    // A port that was free a moment ago: nothing listens on it.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const telemetry = registerTelemetry({
      appId: "notes",
      version: "0.1.0",
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}/` },
    });
    expect(telemetry.enabled).toBe(true);
    expect(registerTelemetry({ appId: "notes", version: "0.1.0", env: {} })).toBe(telemetry);

    const span = trace
      .getTracer("next.js")
      .startSpan("GET /api/notes", { kind: SpanKind.SERVER, attributes: { "next.route": "/api/notes" } });
    expect(span.isRecording()).toBe(true);
    span.end();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
  });
});
