import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
  type HistogramMetricData,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, it } from "vitest";
import {
  REQUEST_DURATION_METRIC,
  RedactingSpanExporter,
  RouteMetricsProcessor,
  UNMATCHED_ROUTE,
} from "../src/index.ts";

class TestReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

/** A tracer wired like registerTelemetry, but to in-memory sinks and not registered globally. */
function setup() {
  const reader = new TestReader();
  const meterProvider = new MeterProvider({ readers: [reader] });
  const exported = new InMemorySpanExporter();
  const tracerProvider = new NodeTracerProvider({
    spanProcessors: [
      new RouteMetricsProcessor(meterProvider.getMeter("test")),
      new SimpleSpanProcessor(new RedactingSpanExporter(exported)),
    ],
  });
  const tracer = tracerProvider.getTracer("next.js");
  const histogram = async () => {
    const { resourceMetrics } = await reader.collect();
    const metric = resourceMetrics.scopeMetrics
      .flatMap((s) => s.metrics)
      .find((m) => m.descriptor.name === REQUEST_DURATION_METRIC);
    return (metric as HistogramMetricData | undefined)?.dataPoints ?? [];
  };
  return {
    tracer,
    exported,
    histogram,
    shutdown: () => Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]),
  };
}

/** A server span shaped like the one Next.js emits for a route handler. */
function request(tracer: ReturnType<typeof setup>["tracer"], url: string, route: string | undefined, status: number) {
  const span = tracer.startSpan(`GET ${url}`, {
    kind: SpanKind.SERVER,
    attributes: {
      "http.method": "GET",
      "http.target": url,
      "http.url": `http://localhost:3020${url}`,
      "user_agent.original": "vitest",
      "next.span_type": "BaseServer.handleRequest",
      ...(route ? { "next.route": route, "http.route": route } : {}),
      "http.status_code": status,
    },
  });
  span.addEvent("exception", { "exception.type": "Error", "exception.message": "note abc-123 for jane@example.com" });
  if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}

let current: ReturnType<typeof setup> | undefined;
afterEach(async () => {
  await current?.shutdown();
  current = undefined;
});

describe("exported spans", () => {
  it("carry the route pattern, never the raw URL, query or other attributes", () => {
    current = setup();
    request(current.tracer, "/api/notes/abc-123?q=secret", "/api/notes/[id]", 200);
    const [span] = current.exported.getFinishedSpans();
    expect(span?.name).toBe("GET /api/notes/[id]");
    expect(span?.attributes).toEqual({
      "http.method": "GET",
      "next.span_type": "BaseServer.handleRequest",
      "next.route": "/api/notes/[id]",
      "http.route": "/api/notes/[id]",
      "http.status_code": 200,
    });
    expect(span?.events[0]?.attributes).toEqual({ "exception.type": "Error" });
    expect(JSON.stringify(span?.attributes)).not.toMatch(/abc-123|secret|example\.com|vitest/);
  });

  it("strip the query string from the name when no route is known", () => {
    current = setup();
    request(current.tracer, "/nowhere?token=secret", undefined, 404);
    expect(current.exported.getFinishedSpans()[0]?.name).toBe("GET /nowhere");
  });
});

describe("route metrics", () => {
  it("record one duration sample per request, keyed by route pattern, method and status", async () => {
    current = setup();
    request(current.tracer, "/api/notes/a?x=1", "/api/notes/[id]", 200);
    request(current.tracer, "/api/notes/b", "/api/notes/[id]", 200);
    request(current.tracer, "/api/notes", "/api/notes", 503);
    request(current.tracer, "/missing", undefined, 404);
    current.tracer.startSpan("render", { kind: SpanKind.INTERNAL }).end();

    const points = await current.histogram();
    const byKey = Object.fromEntries(points.map((p) => [JSON.stringify(p.attributes), p.value.count]));
    expect(byKey).toEqual({
      [JSON.stringify({
        "http.route": "/api/notes/[id]",
        "http.request.method": "GET",
        "http.response.status_code": 200,
      })]: 2,
      [JSON.stringify({
        "http.route": "/api/notes",
        "http.request.method": "GET",
        "http.response.status_code": 503,
        "error.type": "503",
      })]: 1,
      [JSON.stringify({
        "http.route": UNMATCHED_ROUTE,
        "http.request.method": "GET",
        "http.response.status_code": 404,
      })]: 1,
    });
  });
});
