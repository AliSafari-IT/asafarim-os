/**
 * @asafarim/telemetry (P6.2): traces, per-route request metrics and
 * trace-stamped logs for an OS app, exported over OTLP. Off unless
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 *
 *   registerTelemetry({ appId: manifest.id, version: manifest.version });  // first thing in instrumentation.ts
 *   const log = createLogger({ app: "notes" });                            // lines carry trace_id inside a request
 */
export * from "./logger.ts";
export * from "./register.ts";
export * from "./spans.ts";
