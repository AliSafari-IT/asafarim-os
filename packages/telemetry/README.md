# @asafarim/telemetry

OpenTelemetry traces, per-route request metrics (`http.server.request.duration`) and trace-stamped JSON logs for an ASafariM OS app (P6.2, ADR 0001 §9). Nothing is registered or sent unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

```ts
// instrumentation.ts, first thing
registerTelemetry({ appId: manifest.id, version: manifest.version });
const log = createLogger({ app: "notes" }); // lines carry trace_id / span_id inside a request
```

## Trace context through the gateway

A request reaches an app as browser or edge → dev gateway (Caddy) → `forward_auth` to core-api's `/authz/check` → the app.

- **The gateway passes it through.** Caddy's `reverse_proxy`, and `forward_auth`, which is a `reverse_proxy` to the check, forward the incoming request headers unchanged apart from hop-by-hop headers and the `X-Forwarded-*` ones it sets. `traceparent` and `tracestate` aren't hop-by-hop, so both the check and the app get them as the caller sent them. The generated `dev.Caddyfile` must not strip them; `tools/platform-cli/src/sync.test.ts` checks that.
- **The app continues it.** `registerTelemetry` registers the tracer provider with the default W3C Trace Context and Baggage propagator. Next.js extracts the incoming context with that global propagator before it starts its server span, so the app's spans keep the caller's trace id. `test/propagation.test.ts` proves this with a real HTTP request.
- **What isn't traced yet:**
  - The gateway records no span: Caddy's `tracing` directive is off because it needs an exporter, which is a VPS and Grafana decision.
  - core-api has no telemetry, so the auth check adds no span.
  - So the check and the app request share a trace only when the browser or the edge sends a `traceparent`. Without one, each app request starts its own trace.
