/**
 * Server spans for a plain node:http service (P6 part 2c): `traceHttpHandler` continues the
 * caller's trace, names the span after the route pattern and records only allowlisted attributes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SpanStatusCode } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALLOWED_SPAN_ATTRIBUTES, httpMethodOf, traceHttpHandler, UNMATCHED_ROUTE } from "../src/index.ts";
import { registerTestTelemetry, SpanKind, type TestTelemetry } from "../src/testing.ts";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

let telemetry: TestTelemetry;
let server: Server | undefined;

beforeEach(() => {
  telemetry = registerTestTelemetry();
});

afterEach(async () => {
  const open = server;
  if (open) await new Promise<void>((resolve) => open.close(() => resolve()));
  server = undefined;
  await telemetry.shutdown();
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => unknown): Promise<string> {
  const listening = createServer(
    traceHttpHandler(handler, { route: (req) => (req.url?.startsWith("/items/") ? "/items/:id" : undefined) }),
  );
  server = listening;
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
}

async function finishedSpans(count: number) {
  await vi.waitFor(() => expect(telemetry.spans()).toHaveLength(count));
  return telemetry.spans();
}

describe("traceHttpHandler", () => {
  it("continues the caller's trace in a SERVER span named after the route pattern", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    await fetch(`${base}/items/abc-123?token=secret`, {
      headers: { traceparent: TRACEPARENT, cookie: "session=secret", "user-agent": "secret-agent" },
    });

    const [span] = await finishedSpans(1);
    expect(span?.kind).toBe(SpanKind.SERVER);
    expect(span?.name).toBe("GET /items/:id");
    expect(span?.spanContext().traceId).toBe(TRACE_ID);
    expect(span?.attributes).toEqual({
      "http.request.method": "GET",
      "http.route": "/items/:id",
      "http.response.status_code": 204,
    });
    for (const key of Object.keys(span?.attributes ?? {})) expect(ALLOWED_SPAN_ATTRIBUTES.has(key)).toBe(true);
    expect(JSON.stringify([span?.name, span?.attributes, span?.events])).not.toMatch(/abc-123|secret/);
  });

  it("a 5xx is an error, and the request metric counts it under its route", async () => {
    const base = await serve((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    await fetch(`${base}/items/x`);
    await fetch(`${base}/elsewhere`);

    const spans = await finishedSpans(2);
    const failed = spans.find((s) => s.name === "GET /items/:id");
    expect(failed?.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed?.attributes["error.type"]).toBe("503");
    expect(spans.find((s) => s.name === "GET")?.attributes["http.route"]).toBeUndefined();
    const routes = (await telemetry.durations()).map((d) => d.attributes["http.route"]).sort();
    expect(routes).toEqual(["/items/:id", UNMATCHED_ROUTE]);
  });

  it("a handler that throws marks the span with the error's name only, and rethrows", async () => {
    const failing = traceHttpHandler(
      () => {
        throw new TypeError("item abc-123 for jane@example.com");
      },
      { route: () => "/boom" },
    );
    await expect(failing({ method: "POST", headers: {} } as never, { statusCode: 200 } as never)).rejects.toThrow(
      TypeError,
    );

    const [span] = await finishedSpans(1);
    expect(span?.name).toBe("POST /boom");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["error.type"]).toBe("TypeError");
    expect(JSON.stringify(span?.attributes)).not.toMatch(/abc-123|example/);
  });

  it("an unknown method is recorded as _OTHER, never as sent", () => {
    expect(httpMethodOf("GET")).toBe("GET");
    expect(httpMethodOf("DELETE")).toBe("DELETE");
    expect(httpMethodOf("get")).toBe("_OTHER");
    expect(httpMethodOf("SECRET-VERB")).toBe("_OTHER");
    expect(httpMethodOf(undefined)).toBe("_OTHER");
  });
});
