/**
 * What leaves the app (P6.2). Next.js emits its own spans once a tracer
 * provider is registered; these two pieces sit between those spans and the
 * collector:
 *
 *   - `RouteMetricsProcessor` turns each finished server span into one
 *     `http.server.request.duration` sample, keyed by the route pattern
 *     (`/api/notes/[id]`), never the raw URL;
 *   - `RedactingSpanExporter` keeps only an allowlist of attributes and
 *     rebuilds the span name from method and route, so no query string, id,
 *     header or user input reaches the collector.
 */
import { SpanKind, type Attributes, type Histogram, type Meter } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/** Span attributes that may leave the app; everything else is dropped. */
export const ALLOWED_SPAN_ATTRIBUTES: ReadonlySet<string> = new Set([
  "http.method",
  "http.request.method",
  "http.status_code",
  "http.response.status_code",
  "http.route",
  "next.route",
  "next.span_name",
  "next.span_type",
  "next.rsc",
  "next.segment",
  "error.type",
]);

/** Event attributes that may leave the app: the exception's type, never its message or stack. */
const ALLOWED_EVENT_ATTRIBUTES: ReadonlySet<string> = new Set(["exception.type"]);

export const UNMATCHED_ROUTE = "unmatched";

function pick(attributes: Attributes, allowed: ReadonlySet<string>): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) if (allowed.has(key)) out[key] = value;
  return out;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The route pattern of a span (`/api/notes/[id]`), if Next.js set one. */
export function routeOf(span: Pick<ReadableSpan, "attributes">): string | undefined {
  return str(span.attributes["http.route"]) ?? str(span.attributes["next.route"]);
}

function methodOf(span: Pick<ReadableSpan, "attributes">): string | undefined {
  return str(span.attributes["http.request.method"]) ?? str(span.attributes["http.method"]);
}

function statusOf(span: Pick<ReadableSpan, "attributes">): number | undefined {
  const value = span.attributes["http.response.status_code"] ?? span.attributes["http.status_code"];
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) ? n : undefined;
}

/** A span name safe to export: `GET /api/notes/[id]` when the route is known, else the name without its query string. */
export function safeSpanName(span: Pick<ReadableSpan, "attributes" | "name">): string {
  const route = routeOf(span);
  const method = methodOf(span);
  if (route) return method ? `${method} ${route}` : route;
  const query = span.name.indexOf("?");
  return query === -1 ? span.name : span.name.slice(0, query);
}

/** The span as exported: same span, with only allowlisted attributes and a safe name. */
export function redactSpan(span: ReadableSpan): ReadableSpan {
  return Object.create(span, {
    name: { value: safeSpanName(span), enumerable: true },
    attributes: { value: pick(span.attributes, ALLOWED_SPAN_ATTRIBUTES), enumerable: true },
    events: {
      value: span.events.map((event) => ({
        ...event,
        attributes: event.attributes && pick(event.attributes, ALLOWED_EVENT_ATTRIBUTES),
      })),
      enumerable: true,
    },
  }) as ReadableSpan;
}

/** Wraps an exporter so every span it sends is redacted first. */
export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    this.inner.export(spans.map(redactSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

export const REQUEST_DURATION_METRIC = "http.server.request.duration";

/**
 * Request rate, errors and duration per route (RED), derived from the server
 * spans: each finished SERVER span records one duration sample. Count and
 * error rate come from the same histogram (its count, filtered by status).
 */
export class RouteMetricsProcessor implements SpanProcessor {
  private readonly duration: Histogram;

  constructor(meter: Meter) {
    this.duration = meter.createHistogram(REQUEST_DURATION_METRIC, {
      description: "Duration of HTTP server requests, per route pattern.",
      unit: "s",
    });
  }

  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    if (span.kind !== SpanKind.SERVER) return;
    const attributes: Attributes = { "http.route": routeOf(span) ?? UNMATCHED_ROUTE };
    const method = methodOf(span);
    if (method) attributes["http.request.method"] = method;
    const status = statusOf(span);
    if (status !== undefined) attributes["http.response.status_code"] = status;
    if (status !== undefined && status >= 500) attributes["error.type"] = String(status);
    const [seconds, nanos] = span.duration;
    this.duration.record(seconds + nanos / 1e9, attributes);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
