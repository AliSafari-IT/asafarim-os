/**
 * Trace context across the gateway (P6 part 2b). The dev gateway (Caddy) passes
 * `traceparent` and `tracestate` through unchanged to core-api's forward_auth
 * check and to the app. What makes the app's spans join that trace is the global
 * W3C propagator `registerTelemetry` installs: Next.js extracts the incoming
 * context from the request headers with it (`withPropagatedContext`) before it
 * starts its server span. This file proves that propagator is in place, with a
 * real HTTP request carrying the headers the gateway forwards.
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { context, metrics, propagation, ROOT_CONTEXT, SpanKind, trace } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerTelemetry, type Telemetry } from "../src/index.ts";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`;
const TRACESTATE = "edge=t61rcWkgMzE";

let telemetry: Telemetry;

beforeAll(async () => {
  telemetry = registerTelemetry({
    appId: "notes",
    version: "0.1.0",
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: await deadEndpoint() },
  });
});

afterAll(async () => {
  await telemetry.shutdown();
  trace.disable();
  metrics.disable();
  propagation.disable();
  context.disable();
});

/** A port nothing listens on: the exporter's batches are dropped, the test never waits on a collector. */
async function deadEndpoint(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** What the app sees: the headers of one request, as Node's HTTP server parses them. */
async function headersOf(sent: Record<string, string>): Promise<IncomingHttpHeaders> {
  let seen: IncomingHttpHeaders = {};
  const server = createServer((req, res) => {
    seen = req.headers;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fetch(`http://127.0.0.1:${port}/api/notes`, { headers: sent });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return seen;
}

describe("trace context from the gateway", () => {
  it("a server span continues the incoming traceparent once telemetry is registered", async () => {
    expect(telemetry.enabled).toBe(true);

    const headers = await headersOf({ traceparent: TRACEPARENT, tracestate: TRACESTATE });
    // As Next.js does it: extract with the global propagator, then start the server span in that context.
    const incoming = propagation.extract(ROOT_CONTEXT, headers);
    const span = trace.getTracer("next.js").startSpan("GET /api/notes", { kind: SpanKind.SERVER }, incoming);

    expect(span.isRecording()).toBe(true);
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.spanContext().spanId).not.toBe(PARENT_SPAN_ID);
    expect(span.spanContext().traceState?.serialize()).toBe(TRACESTATE);
    span.end();

    // And what the app sends on carries the same trace.
    const out: Record<string, string> = {};
    propagation.inject(trace.setSpan(ROOT_CONTEXT, span), out);
    expect(out.traceparent).toMatch(new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`));
  });

  it("a malformed traceparent starts a new trace instead of failing the request", () => {
    const incoming = propagation.extract(ROOT_CONTEXT, { traceparent: "00-not-a-trace-01" });
    const span = trace.getTracer("next.js").startSpan("GET /api/notes", { kind: SpanKind.SERVER }, incoming);
    expect(span.isRecording()).toBe(true);
    expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanContext().traceId).not.toMatch(/^0+$/);
    expect(span.spanContext().traceId).not.toBe(TRACE_ID);
    span.end();
  });
});
