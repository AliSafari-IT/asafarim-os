import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { activeTraceContext, eventContext, redactSpan, traceEventHandler, type TracedEvent } from "../src/index.ts";

// Registered globally, like registerTelemetry does it: the W3C propagator and a context manager.
const exported = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exported)] });
provider.register();
afterEach(() => exported.reset());
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  propagation.disable();
  context.disable();
});

const TYPE = "notes.note.created.v1";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const tracer = trace.getTracer("test");

/** An event as the publisher would write it inside `span`. */
const eventFrom = (traceContext: object | undefined): TracedEvent => ({ id: "01J", type: TYPE, ...traceContext });

describe("activeTraceContext (publish side)", () => {
  it("is the active span's traceparent, and nothing outside a span", () => {
    expect(activeTraceContext()).toBeUndefined();
    tracer.startActiveSpan("POST /api/notes", (span) => {
      const { traceId, spanId } = span.spanContext();
      expect(activeTraceContext()).toEqual({ traceparent: `00-${traceId}-${spanId}-01` });
      span.end();
    });
    expect(activeTraceContext()).toBeUndefined();
  });

  it("is nothing for a context without a valid span", () => {
    expect(activeTraceContext(ROOT_CONTEXT)).toBeUndefined();
    const invalid = trace.wrapSpanContext({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 1 });
    expect(activeTraceContext(trace.setSpan(ROOT_CONTEXT, invalid))).toBeUndefined();
  });
});

describe("traceEventHandler (consume side)", () => {
  it("round trip: the handler's CONSUMER span is the child of the publishing span, in the same trace", async () => {
    let published: TracedEvent | undefined;
    let publisher: { traceId: string; spanId: string } | undefined;
    tracer.startActiveSpan("POST /api/notes", (span) => {
      publisher = span.spanContext();
      published = eventFrom(activeTraceContext());
      span.end();
    });
    let inner: { traceId: string; spanId: string } | undefined;
    const handled = await traceEventHandler(async (event: TracedEvent, n: number) => {
      inner = trace.getActiveSpan()?.spanContext();
      return `${event.id}:${n}`;
    })(published!, 7);

    expect(handled).toBe("01J:7");
    const consumer = exported.getFinishedSpans().find((s) => s.name === `${TYPE} process`);
    expect(consumer?.kind).toBe(SpanKind.CONSUMER);
    expect(consumer?.spanContext().traceId).toBe(publisher!.traceId);
    expect(consumer?.parentSpanContext?.spanId).toBe(publisher!.spanId);
    expect(inner?.traceId).toBe(publisher!.traceId);
    expect(inner?.spanId).toBe(consumer?.spanContext().spanId);
  });

  it("carries the tracestate on: a context captured inside the handler has it, with the handler's span id", async () => {
    const event = eventFrom({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`, tracestate: "rojo=00f067aa0ba902b7" });
    const inside = await traceEventHandler(async () => activeTraceContext())(event);
    expect(inside?.tracestate).toBe("rojo=00f067aa0ba902b7");
    expect(inside?.traceparent).toMatch(new RegExp(`^00-${TRACE_ID}-(?!${SPAN_ID})[0-9a-f]{16}-01$`));
  });

  it("ignores an invalid traceparent: the handler's span starts a new trace", async () => {
    for (const traceparent of [
      `01-${TRACE_ID}-${SPAN_ID}-01`, // another version (the OpenTelemetry propagator would take it)
      `00-${"0".repeat(32)}-${SPAN_ID}-01`,
      `00-${TRACE_ID}-${"0".repeat(16)}-01`,
      `00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`,
      `00-${TRACE_ID}-${SPAN_ID}-001`,
      42,
    ]) {
      const event = eventFrom({ traceparent, tracestate: "rojo=1" });
      expect(trace.getSpanContext(eventContext(event))).toBeUndefined();
      await traceEventHandler(async () => undefined)(event);
      const [span] = exported.getFinishedSpans();
      expect(span?.parentSpanContext, String(traceparent)).toBeUndefined();
      expect(span?.spanContext().traceId).not.toBe(TRACE_ID);
      expect(span?.spanContext().traceState).toBeUndefined();
      exported.reset();
    }
  });

  it("never joins the span active in the consumer's loop when the event carries no context", async () => {
    await tracer.startActiveSpan("loop", async (loop) => {
      await traceEventHandler(async () => undefined)(eventFrom(undefined));
      loop.end();
    });
    const handler = exported.getFinishedSpans().find((s) => s.name === `${TYPE} process`);
    expect(handler?.parentSpanContext).toBeUndefined();
  });

  it("a handler error marks the span (error.type only) and is rethrown; the redacted span keeps its name", async () => {
    const event = eventFrom({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` });
    await expect(
      traceEventHandler(async () => {
        throw new TypeError("note 42 for jane@example.com");
      })(event),
    ).rejects.toThrow(TypeError);
    const [span] = exported.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    const redacted = redactSpan(span!);
    expect(redacted.name).toBe(`${TYPE} process`);
    expect(redacted.attributes).toEqual({ "error.type": "TypeError" });
    expect(JSON.stringify({ ...redacted.attributes, status: span?.status })).not.toMatch(/jane|42/);
  });
});
