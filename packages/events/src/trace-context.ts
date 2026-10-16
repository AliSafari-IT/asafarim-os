/**
 * W3C Trace Context on events (P6 part 2a, ADR 0001 §9). The CloudEvents distributed-tracing
 * extension carries the context of the request that published an event as two extension
 * attributes, `traceparent` and `tracestate`, so the consuming app's handler span joins the
 * publisher's trace across the outbox, the relay and the bus.
 *
 * Pure and dependency-free: this package doesn't depend on OpenTelemetry. `@asafarim/telemetry`
 * supplies the OpenTelemetry side (`activeTraceContext` captures it at publish time,
 * `traceEventHandler` continues it in the consumer).
 *
 * https://www.w3.org/TR/trace-context/ and
 * https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/extensions/distributed-tracing.md
 */

/**
 * W3C traceparent, version 00 only: `00-<32 hex trace id, not all zeros>-<16 hex span id, not all
 * zeros>-<2 hex flags>`, lowercase (https://www.w3.org/TR/trace-context/#traceparent-header).
 */
export const TRACEPARENT = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;

/** The longest tracestate an event carries (the length W3C requires every vendor to propagate). */
export const TRACESTATE_MAX_LENGTH = 512;
const TRACESTATE_MAX_MEMBERS = 32;
/** A tracestate key: `vendor` or `tenant@vendor` (https://www.w3.org/TR/trace-context/#key). */
const TRACESTATE_KEY = /^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})$/;
/** A tracestate value: printable ASCII except `,` and `=`, not ending in a space. */
const TRACESTATE_VALUE = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;

/** The trace context an event carries: a valid traceparent, and a tracestate only with one. */
export interface TraceContext {
  traceparent: string;
  tracestate?: string;
}

/** What a traceparent says. */
export interface Traceparent {
  /** 32 lowercase hex characters. */
  traceId: string;
  /** 16 lowercase hex characters: the span that published the event. */
  spanId: string;
  /** The trace flags byte (bit 0: sampled). */
  traceFlags: number;
}

/**
 * Where a publisher reads the active request's trace context from when `publish` isn't given one
 * (`activeTraceContext` from `@asafarim/telemetry`). Returns undefined outside a span or with
 * telemetry off. Whatever it returns is validated; an invalid value is ignored.
 */
export type TraceContextSource = () => { traceparent?: unknown; tracestate?: unknown } | undefined;

export const isTraceparent = (value: unknown): value is string => typeof value === "string" && TRACEPARENT.test(value);

/** A W3C tracestate: 1–32 `key=value` members, unique keys, at most TRACESTATE_MAX_LENGTH characters. */
export function isTracestate(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > TRACESTATE_MAX_LENGTH) return false;
  const keys = new Set<string>();
  for (const raw of value.split(",")) {
    const member = raw.trim();
    if (member === "") continue; // W3C allows empty members
    const eq = member.indexOf("=");
    if (eq <= 0) return false;
    const key = member.slice(0, eq);
    if (!TRACESTATE_KEY.test(key) || !TRACESTATE_VALUE.test(member.slice(eq + 1)) || keys.has(key)) return false;
    keys.add(key);
  }
  return keys.size > 0 && keys.size <= TRACESTATE_MAX_MEMBERS;
}

/** Split a traceparent; undefined unless it is a valid version-00 one. */
export function parseTraceparent(value: unknown): Traceparent | undefined {
  if (!isTraceparent(value)) return undefined;
  const [, traceId, spanId, flags] = value.split("-") as [string, string, string, string];
  return { traceId, spanId, traceFlags: Number.parseInt(flags, 16) };
}

/**
 * The valid trace context of a carrier (an event, a header map), or undefined. Invalid values are
 * ignored, never thrown on: an invalid traceparent drops both, an invalid tracestate drops only
 * itself, and a tracestate without a valid traceparent means nothing.
 */
export function traceContextOf(
  carrier: { traceparent?: unknown; tracestate?: unknown } | null | undefined,
): TraceContext | undefined {
  if (!carrier || !isTraceparent(carrier.traceparent)) return undefined;
  return isTracestate(carrier.tracestate)
    ? { traceparent: carrier.traceparent, tracestate: carrier.tracestate }
    : { traceparent: carrier.traceparent };
}
