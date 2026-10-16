/**
 * Server spans for a plain Node HTTP server (P6 part 2c): Next.js apps get theirs from Next.js,
 * a service on `node:http` (core-api) wraps its handler instead.
 *
 *   createServer(traceHttpHandler(handler, { route: (req) => routePattern(req) }));
 *
 * Each request runs in a SERVER span that continues the caller's `traceparent`/`tracestate`
 * (extracted with the global propagator, so a forwarded auth check joins the request's trace;
 * an invalid one starts a new trace). The span is named `METHOD /route/pattern` and carries only
 * the method, the route pattern, the status code and, on a 5xx, `error.type`: never the URL, a
 * query string, a header, a cookie or anything the handler decided. `RouteMetricsProcessor`
 * turns it into the same `http.server.request.duration` sample as a Next.js request.
 * Telemetry off: the span is a no-op and the handler runs exactly as before.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, propagation, trace, type Attributes } from "@opentelemetry/api";

/** The methods recorded as they are; anything else is `_OTHER` (OTel semconv), so a client can't name the span. */
const KNOWN_METHODS: ReadonlySet<string> = new Set([
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
]);

export function httpMethodOf(method: string | undefined): string {
  return method !== undefined && KNOWN_METHODS.has(method) ? method : "_OTHER";
}

export interface TraceHttpHandlerOptions<Req extends IncomingMessage> {
  /**
   * The route pattern the request matches (`/admin/v1/apps/:id`), or undefined when none does.
   * A pattern, never the raw path: it names the span and keys the metric.
   */
  route: (req: Req) => string | undefined;
  /** The tracer's name (default "@asafarim/telemetry"). */
  tracerName?: string;
}

/**
 * Wrap a `node:http` request handler so each request runs in a SERVER span. The span ends when
 * the handler settles, with the status the handler wrote (`res.statusCode`). A handler that throws
 * marks the span as an error (`error.type` = the error's name, never its message) and the error is
 * rethrown, as without the wrapper.
 */
export function traceHttpHandler<Req extends IncomingMessage, Res extends ServerResponse>(
  handler: (req: Req, res: Res) => unknown,
  opts: TraceHttpHandlerOptions<Req>,
): (req: Req, res: Res) => Promise<void> {
  const tracerName = opts.tracerName ?? "@asafarim/telemetry";
  return (req, res) => {
    const method = httpMethodOf(req.method);
    const route = opts.route(req);
    const attributes: Attributes = { "http.request.method": method };
    if (route !== undefined) attributes["http.route"] = route;
    const parent = propagation.extract(ROOT_CONTEXT, req.headers);
    return trace
      .getTracer(tracerName)
      .startActiveSpan(
        route === undefined ? method : `${method} ${route}`,
        { kind: SpanKind.SERVER, attributes },
        parent,
        async (span) => {
          try {
            await handler(req, res);
            const status = res.statusCode;
            span.setAttribute("http.response.status_code", status);
            if (status >= 500) {
              span.setAttribute("error.type", String(status));
              span.setStatus({ code: SpanStatusCode.ERROR });
            }
          } catch (err) {
            span.setAttribute("error.type", err instanceof Error ? err.name : "Error");
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw err;
          } finally {
            span.end();
          }
        },
      );
  };
}
