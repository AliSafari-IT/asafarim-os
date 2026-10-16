/**
 * Flushing on shutdown: `shutdown()` exports what is still pending, once, within its timeout, and
 * never rejects; `installShutdownFlush` flushes on a signal without exiting or swallowing it.
 * Providers wired like `registerTelemetry`'s, but to in-memory exporters and never registered globally.
 */
import { SpanKind } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, InMemorySpanExporter, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  REQUEST_DURATION_METRIC,
  RouteMetricsProcessor,
  flushThenShutdown,
  installShutdownFlush,
  registerTelemetry,
} from "../src/index.ts";

const HOUR = 3_600_000;

/** Keeps what it was sent after shutdown (InMemorySpanExporter forgets its spans when shut down). */
class KeepingSpanExporter extends InMemorySpanExporter {
  override shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** An exporter whose collector never answers: no export, flush or shutdown ever completes. */
const never = () => new Promise<void>(() => {});
const hangingSpans: SpanExporter = { export: () => {}, forceFlush: never, shutdown: never };
const hangingMetrics: PushMetricExporter = { export: () => {}, forceFlush: never, shutdown: never };

/** Nothing is exported on its own within a test: only a flush sends the batch and the metrics. */
function setup(spanExporter: SpanExporter, metricExporter: PushMetricExporter, exportTimeoutMillis = 5_000) {
  const meterProvider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: HOUR, exportTimeoutMillis }),
    ],
  });
  const tracerProvider = new NodeTracerProvider({
    spanProcessors: [
      new RouteMetricsProcessor(meterProvider.getMeter("test")),
      new BatchSpanProcessor(spanExporter, { scheduledDelayMillis: HOUR, exportTimeoutMillis }),
    ],
  });
  const request = () =>
    tracerProvider
      .getTracer("next.js")
      .startSpan("GET /api/notes", {
        kind: SpanKind.SERVER,
        attributes: { "http.method": "GET", "http.route": "/api/notes", "http.status_code": 200 },
      })
      .end();
  return { tracerProvider, meterProvider, request };
}

function recordingLog() {
  const warnings: [string, Record<string, unknown> | undefined][] = [];
  return {
    warnings,
    log: { warn: (msg: string, fields?: Record<string, unknown>) => void warnings.push([msg, fields]) },
  };
}

const metricNames = (exporter: InMemoryMetricExporter) =>
  exporter
    .getMetrics()
    .flatMap((r) => r.scopeMetrics)
    .flatMap((s) => s.metrics)
    .map((m) => m.descriptor.name);

describe("flushThenShutdown", () => {
  it("exports the spans still in the batch and the metrics since the last export", async () => {
    const spans = new KeepingSpanExporter();
    const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const { tracerProvider, meterProvider, request } = setup(spans, metrics);
    const { log, warnings } = recordingLog();
    request();
    expect(spans.getFinishedSpans()).toHaveLength(0);
    expect(metrics.getMetrics()).toHaveLength(0);

    await flushThenShutdown([tracerProvider, meterProvider], { timeoutMs: 2_000, log })();

    expect(spans.getFinishedSpans().map((s) => s.name)).toEqual(["GET /api/notes"]);
    expect(metricNames(metrics)).toContain(REQUEST_DURATION_METRIC);
    expect(warnings).toEqual([]);
  });

  it("runs once: a second call returns the same promise and exports nothing twice", async () => {
    const spans = new KeepingSpanExporter();
    const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const { tracerProvider, meterProvider, request } = setup(spans, metrics);
    const tracerShutdown = vi.spyOn(tracerProvider, "shutdown");
    const meterShutdown = vi.spyOn(meterProvider, "shutdown");
    const { log } = recordingLog();
    const shutdown = flushThenShutdown([tracerProvider, meterProvider], { timeoutMs: 2_000, log });
    request();

    const first = shutdown();
    expect(shutdown()).toBe(first);
    await first;
    await shutdown();

    expect(tracerShutdown).toHaveBeenCalledTimes(1);
    expect(meterShutdown).toHaveBeenCalledTimes(1);
    expect(spans.getFinishedSpans()).toHaveLength(1);
  });

  it("resolves within its timeout when the collector never answers", async () => {
    const { tracerProvider, meterProvider, request } = setup(hangingSpans, hangingMetrics, 60_000);
    const { log, warnings } = recordingLog();
    request();

    const started = performance.now();
    await expect(
      flushThenShutdown([tracerProvider, meterProvider], { timeoutMs: 100, log })(),
    ).resolves.toBeUndefined();

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(warnings).toEqual([["telemetry.shutdown_timeout", { timeoutMs: 100 }]]);
  });

  it("never rejects, and reports a failure by error name only", async () => {
    const failing = {
      forceFlush: () => Promise.reject(new TypeError("fetch failed: http://collector.internal:4318/v1/traces")),
      shutdown: () => {
        throw new Error("secret detail");
      },
    };
    const { log, warnings } = recordingLog();

    await expect(flushThenShutdown([failing], { timeoutMs: 2_000, log })()).resolves.toBeUndefined();

    expect(warnings).toEqual([
      ["telemetry.flush_failed", { error: "TypeError" }],
      ["telemetry.shutdown_failed", { error: "Error" }],
    ]);
    expect(JSON.stringify(warnings)).not.toMatch(/collector|secret/);
  });
});

describe("with telemetry off", () => {
  it("shutdown() is a no-op, and installShutdownFlush adds no listener", async () => {
    const telemetry = registerTelemetry({ appId: "notes", version: "0.1.0", env: {} });
    expect(telemetry.enabled).toBe(false);
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();

    const before = process.listenerCount("SIGTERM");
    installShutdownFlush(telemetry);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("installShutdownFlush", () => {
  // Signals no test runner relies on, with every listener set aside and the re-raise stubbed out.
  const signals = ["SIGUSR2", "SIGHUP"] as const;
  let saved: Map<NodeJS.Signals, ReturnType<typeof process.listeners>>;
  let kill: MockInstance<typeof process.kill>;

  beforeAll(() => {
    saved = new Map(signals.map((s) => [s, process.listeners(s)] as const));
    for (const s of signals) process.removeAllListeners(s);
    kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    kill.mockClear();
  });

  afterAll(() => {
    kill.mockRestore();
    for (const s of signals) {
      process.removeAllListeners(s);
      for (const listener of saved.get(s) ?? []) process.on(s, listener as NodeJS.SignalsListener);
    }
  });

  it("flushes on the signal, leaves the exit to the handler that owns it, and installs once", async () => {
    const shutdown = vi.fn(async () => {});
    const owner = vi.fn();
    process.on("SIGUSR2", owner);

    installShutdownFlush({ enabled: true, shutdown }, { signals: ["SIGUSR2"] });
    installShutdownFlush({ enabled: true, shutdown }, { signals: ["SIGUSR2"] });
    expect(process.listenerCount("SIGUSR2")).toBe(2);

    process.emit("SIGUSR2", "SIGUSR2");
    expect(owner).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    await shutdown.mock.results[0]?.value;
    await new Promise((resolve) => setImmediate(resolve));
    expect(kill).not.toHaveBeenCalled();
    expect(process.listenerCount("SIGUSR2")).toBe(1);
  });

  it("raises the signal again after the flush when nothing else handles it", async () => {
    let finish!: () => void;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));

    installShutdownFlush({ enabled: true, shutdown }, { signals: ["SIGHUP"] });
    process.emit("SIGHUP", "SIGHUP");
    expect(shutdown).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(kill).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, "SIGHUP"));
  });
});
