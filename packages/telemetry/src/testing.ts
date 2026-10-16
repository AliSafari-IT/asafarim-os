/**
 * `@asafarim/telemetry/testing`: tests only. A tracer provider registered globally the way
 * `registerTelemetry` does it (W3C propagator, async context, `RouteMetricsProcessor`), but with
 * in-memory sinks, so a service's tests can check the spans and request metrics its code emits
 * without depending on the OpenTelemetry SDK themselves.
 *
 *   const telemetry = registerTestTelemetry();
 *   … make a request …
 *   telemetry.spans();             // finished spans, as recorded (before redaction)
 *   await telemetry.durations();   // the http.server.request.duration points' attributes and counts
 *   await telemetry.shutdown();    // and the globals are unregistered again
 */
import { SpanKind, context, propagation, trace, type Attributes } from "@opentelemetry/api";
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
  type HistogramMetricData,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { REQUEST_DURATION_METRIC, RouteMetricsProcessor } from "./spans.ts";

export { SpanKind, type ReadableSpan };

class InMemoryMetricReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }
  protected override async onForceFlush(): Promise<void> {}
  protected override async onShutdown(): Promise<void> {}
}

export interface TestTelemetry {
  /** The finished spans, as recorded: what the code put on them, before the exporter's redaction. */
  spans(): ReadableSpan[];
  /** One entry per `http.server.request.duration` series: its attributes and its sample count. */
  durations(): Promise<{ attributes: Attributes; count: number }[]>;
  /** Forget the spans recorded so far. */
  reset(): void;
  /** Stop, and unregister the global tracer provider, propagator and context manager. */
  shutdown(): Promise<void>;
}

export function registerTestTelemetry(): TestTelemetry {
  const reader = new InMemoryMetricReader();
  const meterProvider = new MeterProvider({ readers: [reader] });
  const exporter = new InMemorySpanExporter();
  const tracerProvider = new NodeTracerProvider({
    spanProcessors: [
      new RouteMetricsProcessor(meterProvider.getMeter("@asafarim/telemetry")),
      new SimpleSpanProcessor(exporter),
    ],
  });
  tracerProvider.register();
  return {
    spans: () => exporter.getFinishedSpans(),
    durations: async () => {
      const { resourceMetrics } = await reader.collect();
      const metric = resourceMetrics.scopeMetrics
        .flatMap((s) => s.metrics)
        .find((m) => m.descriptor.name === REQUEST_DURATION_METRIC) as HistogramMetricData | undefined;
      return (metric?.dataPoints ?? []).map((p) => ({ attributes: p.attributes, count: p.value.count }));
    },
    reset: () => exporter.reset(),
    shutdown: async () => {
      await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
      trace.disable();
      propagation.disable();
      context.disable();
    },
  };
}
