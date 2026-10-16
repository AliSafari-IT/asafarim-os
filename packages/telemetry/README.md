# @asafarim/telemetry

OpenTelemetry traces, per-route request metrics (`http.server.request.duration`) and trace-stamped JSON logs for an ASafariM OS app (P6.2, ADR 0001 §9). Nothing is registered or sent unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

```ts
// instrumentation.ts, first thing
installShutdownFlush(registerTelemetry({ appId: manifest.id, version: manifest.version })); // flush on SIGTERM (below)
const log = createLogger({ app: "notes" }); // lines carry trace_id / span_id inside a request
```

## Trace context through the gateway

A request reaches an app as browser or edge → dev gateway (Caddy) → `forward_auth` to core-api's `/authz/check` → the app.

- **The gateway passes it through.** Caddy's `reverse_proxy`, and `forward_auth`, which is a `reverse_proxy` to the check, forward the incoming request headers unchanged apart from hop-by-hop headers and the `X-Forwarded-*` ones it sets. `traceparent` and `tracestate` aren't hop-by-hop, so both the check and the app get them as the caller sent them. The generated `dev.Caddyfile` must not strip them; `tools/platform-cli/src/sync.test.ts` checks that.
- **The app continues it.** `registerTelemetry` registers the tracer provider with the default W3C Trace Context and Baggage propagator. Next.js extracts the incoming context with that global propagator before it starts its server span, so the app's spans keep the caller's trace id. `test/propagation.test.ts` proves this with a real HTTP request.
- **core-api continues it too (P6 part 2c).** core-api is a plain `node:http` server, so it has no framework spans: `traceHttpHandler` (below) runs each request, `/authz/check` included, in a SERVER span that continues the incoming `traceparent`. The forward_auth check is a span of the same trace as the app's request, and core-api's admin and registry calls are traced the same way.
- **What isn't traced yet:**
  - The gateway records no span: Caddy's `tracing` directive is off because it needs an exporter, which is a VPS and Grafana decision.
  - So the check and the app request share a trace only when the browser or the edge sends a `traceparent`. Without one, the check and the app request each start their own trace.

## Shutdown

Spans wait in the batch processor and metrics are exported every 15 s, so a process that stops without flushing loses the last few seconds of both. `registerTelemetry` returns a handle whose `shutdown()` force-flushes, then shuts down, the tracer and meter providers. It resolves within `shutdownTimeoutMs` (default 2 s, the export timeout) however the collector behaves, returns the same promise on every call, never rejects (a failure is logged as `telemetry.flush_failed` / `telemetry.shutdown_failed` with the error's name only, a timeout as `telemetry.shutdown_timeout`), and is a no-op with telemetry off.

- **A service that owns its signals awaits it before exiting.** core-api, on SIGTERM or SIGINT: stop accepting connections, stop the bus's auth callout, `await telemetry.shutdown()`, `process.exit(0)` (`createShutdown` in `core/core-api/src/server.ts`).
- **A Next.js app leaves the signals to Next.** `instrumentation.ts` calls `installShutdownFlush(registerTelemetry(…))`: one `process.once` listener per signal (SIGTERM, SIGINT; none with telemetry off, never two) that starts `shutdown()` and never calls `process.exit`, so Next's own handling goes on as before. If nothing else listens for the signal, the listener raises it again once the flush is done, so the process still stops.
- **Limitation (Next.js): the flush is best effort.** Next's server handles SIGTERM and SIGINT itself and calls `process.exit` once its HTTP server has closed. The flush runs alongside that and isn't awaited by it: when the server closes before the OTLP export completes (an idle server closes almost at once), the process exits mid-export and that last batch is lost. We don't work around it (taking the signals from Next with `NEXT_MANUAL_SIG_HANDLE` would mean owning its graceful close too). core-api's flush is awaited, so it isn't affected.

## A plain Node HTTP service

```ts
createServer(traceHttpHandler(handler, { route: (req) => routePattern(req) }));
```

Each request runs in a SERVER span named `METHOD /route/pattern` (just `METHOD` when no route matches), continuing the caller's trace through the global propagator; an invalid `traceparent` starts a new trace. The span carries only `http.request.method` (`_OTHER` for an unknown method), `http.route`, `http.response.status_code` and, on a 5xx or a thrown error, `error.type`: never the URL, a query string, a header, a cookie or what the handler decided. `RouteMetricsProcessor` records the same `http.server.request.duration` sample as for a Next.js request. Tests use `registerTestTelemetry()` from `@asafarim/telemetry/testing`: the same processors, in-memory sinks.
