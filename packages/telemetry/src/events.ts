/**
 * Tracing across the bus (P6 part 2a, ADR 0001 §9): the W3C trace context travels in each event's
 * CloudEvents extension attributes (`traceparent`, `tracestate`), so a trace runs from the request
 * that published an event, through the outbox and the relay, into the consuming app's handler.
 *
 *   createPublisher({ manifest, schemas, traceContext: activeTraceContext }); // captured at outbox-write time
 *   subscribe(type, traceEventHandler(async (event, tx) => {…}), opts);       // the handler's span continues it
 *
 * Telemetry off (no tracer provider, so the no-op propagator) or no active span: `activeTraceContext`
 * returns undefined and the event carries nothing new. Only the trace and span ids (and the
 * vendors' tracestate) leave the app this way; baggage, which may hold user data, never does.
 */
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, propagation, trace, type Context } from "@opentelemetry/api";

/**
 * W3C traceparent, version 00 only (the same rule as `TRACEPARENT` in @asafarim/events, which this
 * package doesn't depend on). Stricter than the OpenTelemetry propagator, which also accepts
 * future versions.
 */
const TRACEPARENT = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;
/** The longest tracestate taken from an event (as @asafarim/events' TRACESTATE_MAX_LENGTH). */
const TRACESTATE_MAX_LENGTH = 512;

/** The trace context an event carries. */
export interface EventTraceContext {
  traceparent: string;
  tracestate?: string;
}

/** The part of a CloudEvent tracing reads (structurally compatible with @asafarim/events' CloudEvent). */
export interface TracedEvent {
  id: string;
  type: string;
  traceparent?: unknown;
  tracestate?: unknown;
}

/** The W3C trace context of `ctx` (the active one by default), or undefined without a valid span or with telemetry off. */
export function activeTraceContext(ctx: Context = context.active()): EventTraceContext | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  const { traceparent, tracestate } = carrier;
  if (traceparent === undefined || !TRACEPARENT.test(traceparent)) return undefined;
  return tracestate && tracestate.length <= TRACESTATE_MAX_LENGTH ? { traceparent, tracestate } : { traceparent };
}

/**
 * The context an event's handler runs in: the event's trace when it carries a valid traceparent,
 * otherwise none (a new trace). Built on `parent` (the root context by default), so a handler never
 * joins whatever happens to be active in the consumer's loop. An invalid traceparent is ignored.
 */
export function eventContext(event: TracedEvent, parent: Context = ROOT_CONTEXT): Context {
  const { traceparent, tracestate } = event;
  if (typeof traceparent !== "string" || !TRACEPARENT.test(traceparent)) return parent;
  const carrier: Record<string, string> = { traceparent };
  if (typeof tracestate === "string" && tracestate.length <= TRACESTATE_MAX_LENGTH) carrier.tracestate = tracestate;
  return propagation.extract(parent, carrier);
}

export interface TraceEventHandlerOptions {
  /** The tracer's name (default "@asafarim/telemetry"). */
  tracerName?: string;
}

/**
 * Wrap an event handler so it runs in a CONSUMER span named `<event type> process`, the CHILD of
 * the span that published the event: one trace from the request to every consumer's handler.
 * A handler error marks the span as an error (`error.type` = the error's name, never its message)
 * and is rethrown, so the subscriber's retries and dead letters work as before; each redelivery is
 * one more child span. Without telemetry the span is a no-op.
 */
export function traceEventHandler<E extends TracedEvent, A extends unknown[], R>(
  handler: (event: E, ...rest: A) => Promise<R>,
  opts: TraceEventHandlerOptions = {},
): (event: E, ...rest: A) => Promise<R> {
  const tracerName = opts.tracerName ?? "@asafarim/telemetry";
  return (event, ...rest) =>
    trace
      .getTracer(tracerName)
      .startActiveSpan(`${event.type} process`, { kind: SpanKind.CONSUMER }, eventContext(event), async (span) => {
        try {
          return await handler(event, ...rest);
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.setAttribute("error.type", err instanceof Error ? err.name : "Error");
          throw err;
        } finally {
          span.end();
        }
      });
}
