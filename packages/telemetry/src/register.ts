/**
 * Turning telemetry on (P6.2). Off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is
 * set: then nothing is registered and nothing is sent. When on, traces and
 * metrics go over OTLP/HTTP to `<endpoint>/v1/traces` and `<endpoint>/v1/metrics`;
 * an unreachable collector costs dropped batches, never a failed request.
 */
import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { RedactingSpanExporter, RouteMetricsProcessor } from "./spans.ts";

export interface TelemetryOptions {
  /** The app id from the manifest; also the OTel `service.name`. */
  appId: string;
  /** The app version from the manifest. */
  version: string;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** How often metrics are exported, in ms (default 15 000). */
  metricIntervalMs?: number;
}

export interface Telemetry {
  enabled: boolean;
  /** Flushes and stops exporting; never throws. */
  shutdown(): Promise<void>;
}

const EXPORT_TIMEOUT_MS = 2000;
const disabled: Telemetry = { enabled: false, shutdown: async () => {} };
let current: Telemetry | undefined;

export function registerTelemetry({
  appId,
  version,
  env = process.env,
  metricIntervalMs = 15_000,
}: TelemetryOptions): Telemetry {
  if (current) return current;
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/+$/, "");
  if (!endpoint) return disabled;

  const resource = resourceFromAttributes({
    "service.name": appId,
    "service.version": version,
    "app.id": appId,
    "app.version": version,
    "deployment.environment": env.DEPLOYMENT_ENVIRONMENT || env.NODE_ENV || "development",
  });

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics`, timeoutMillis: EXPORT_TIMEOUT_MS }),
        exportIntervalMillis: metricIntervalMs,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [
      new RouteMetricsProcessor(meterProvider.getMeter("@asafarim/telemetry")),
      new BatchSpanProcessor(
        new RedactingSpanExporter(
          new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, timeoutMillis: EXPORT_TIMEOUT_MS }),
        ),
        { exportTimeoutMillis: EXPORT_TIMEOUT_MS },
      ),
    ],
  });
  tracerProvider.register();

  current = {
    enabled: true,
    shutdown: async () => {
      await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
    },
  };
  return current;
}
