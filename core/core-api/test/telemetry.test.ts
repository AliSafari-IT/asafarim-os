/**
 * core-api's traces (P6 part 2c): every request runs in a SERVER span that continues the caller's
 * traceparent, so the gateway's forward_auth check joins the trace of the request it lets through.
 * A real HTTP server around `createHandler`, a gateway with one app and no database.
 */
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { ACCESS_COOKIE_NAME, type SigningKey } from "@asafarim/registry-protocol";
import { ALLOWED_SPAN_ATTRIBUTES, UNMATCHED_ROUTE } from "@asafarim/telemetry";
import { SpanKind, registerTestTelemetry, type TestTelemetry } from "@asafarim/telemetry/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppSnapshot, type GatewayApp } from "../src/gateway.ts";
import type { Registry } from "../src/registry.ts";
import { createHandler, routePattern, startTelemetry } from "../src/server.ts";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`;

const SECRET_COOKIE = "secret-cookie-value";
const SECRET_BEARER = "secret-bearer-value";
const SECRET_QUERY = "secret-query-value";

const key: SigningKey = { kid: "t1", privateJwk: generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }) };
const APPS: GatewayApp[] = [
  {
    id: "notes",
    state: "active",
    manifest: { name: "Notes", routes: [{ path: "/api/notes", methods: ["GET"], permission: "notes.read" }] },
  },
];

let server: Server;
let base: string;

beforeEach(async () => {
  // /authz/check and the refused admin calls touch neither the registry nor the database.
  const handler = createHandler({
    registry: {} as Registry,
    pool: {} as pg.Pool,
    tokenKey: key,
    snapshot: createAppSnapshot(async () => APPS),
    log: () => {},
  });
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The gateway's forward_auth call, as Caddy makes it for `GET <uri>` on the Notes host. */
function authzCheck(uri: string, extra: Record<string, string> = {}) {
  return fetch(`${base}/authz/check`, {
    headers: {
      "x-asafarim-app": "notes",
      "x-forwarded-method": "GET",
      "x-forwarded-uri": uri,
      accept: "application/json",
      ...extra,
    },
  });
}

describe("with telemetry on", () => {
  let telemetry: TestTelemetry;

  beforeEach(() => {
    telemetry = registerTestTelemetry();
  });

  afterEach(async () => {
    await telemetry.shutdown();
  });

  /** The server spans, once the handler has finished (the span ends right after the response is written). */
  async function serverSpans(count: number) {
    await vi.waitFor(() => expect(telemetry.spans()).toHaveLength(count));
    return telemetry.spans().filter((s) => s.kind === SpanKind.SERVER);
  }

  it("the auth check runs in a SERVER span of the caller's trace, named after the route", async () => {
    const res = await authzCheck("/", { traceparent: TRACEPARENT, tracestate: "edge=t61rcWkgMzE" });
    expect(res.status).toBe(200);

    const [span] = await serverSpans(1);
    expect(span?.name).toBe("GET /authz/check");
    expect(span?.spanContext().traceId).toBe(TRACE_ID);
    expect(span?.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
    expect(span?.attributes).toEqual({
      "http.request.method": "GET",
      "http.route": "/authz/check",
      "http.response.status_code": 200,
    });
  });

  it("a refused check records its status, and the request metric is keyed by the route", async () => {
    const res = await authzCheck("/api/notes", { traceparent: TRACEPARENT });
    expect(res.status).toBe(401);

    const [span] = await serverSpans(1);
    expect(span?.spanContext().traceId).toBe(TRACE_ID);
    expect(span?.attributes["http.response.status_code"]).toBe(401);
    expect(await telemetry.durations()).toEqual([
      {
        attributes: { "http.route": "/authz/check", "http.request.method": "GET", "http.response.status_code": 401 },
        count: 1,
      },
    ]);
  });

  it("an invalid traceparent starts a new root trace", async () => {
    const res = await authzCheck("/", { traceparent: "00-not-a-trace-01" });
    expect(res.status).toBe(200);

    const [span] = await serverSpans(1);
    expect(span?.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span?.spanContext().traceId).not.toMatch(/^0+$/);
    expect(span?.spanContext().traceId).not.toBe(TRACE_ID);
    expect(span?.parentSpanContext).toBeUndefined();
  });

  it("admin routes are named after their pattern, never the raw path", async () => {
    const res = await fetch(`${base}/admin/v1/apps/notes`, { headers: { traceparent: TRACEPARENT } });
    expect(res.status).toBe(401);
    const unknown = await fetch(`${base}/nowhere/abc-123?x=1`);
    expect(unknown.status).toBe(404);

    const spans = await serverSpans(2);
    expect(spans.map((s) => s.name).sort()).toEqual(["GET", "GET /admin/v1/apps/:id"]);
    const admin = spans.find((s) => s.name === "GET /admin/v1/apps/:id");
    expect(admin?.spanContext().traceId).toBe(TRACE_ID);
    expect(admin?.attributes["http.route"]).toBe("/admin/v1/apps/:id");
    expect(JSON.stringify(spans.map((s) => [s.name, s.attributes]))).not.toMatch(/notes|abc-123|x=1/);
    const unmatched = (await telemetry.durations()).find((d) => d.attributes["http.route"] === UNMATCHED_ROUTE);
    expect(unmatched?.attributes["http.response.status_code"]).toBe(404);
  });

  it("records no cookie, header, query string or decision: only allowlisted attributes", async () => {
    await authzCheck(`/api/notes?q=${SECRET_QUERY}`, {
      traceparent: TRACEPARENT,
      cookie: `${ACCESS_COOKIE_NAME}=${SECRET_COOKIE}; other=${SECRET_COOKIE}`,
      authorization: `Bearer ${SECRET_BEARER}`,
      "user-agent": "secret-agent",
    });
    await fetch(`${base}/admin/v1/session`, { headers: { authorization: `Bearer ${SECRET_BEARER}` } });

    const spans = await serverSpans(2);
    for (const span of spans) {
      for (const attribute of Object.keys(span.attributes)) expect(ALLOWED_SPAN_ATTRIBUTES.has(attribute)).toBe(true);
      expect(span.events).toEqual([]);
    }
    const recorded = JSON.stringify(spans.map((s) => [s.name, s.attributes]));
    expect(recorded).not.toMatch(/secret|notes\.read|api\/notes|asafarim\.access|Bearer/);
  });
});

describe("with telemetry off", () => {
  it("registers nothing, and the check answers exactly as without tracing", async () => {
    const telemetry = startTelemetry({});
    expect(telemetry.enabled).toBe(false);

    const allowed = await authzCheck("/", { traceparent: TRACEPARENT });
    expect(allowed.status).toBe(200);
    const refused = await authzCheck("/api/notes", { traceparent: TRACEPARENT });
    expect(refused.status).toBe(401);
    // No provider, no propagator: nothing is recorded, nothing is sent back.
    expect(allowed.headers.get("traceparent")).toBeNull();
    expect(refused.headers.get("traceparent")).toBeNull();
  });
});

describe("routePattern", () => {
  it("maps each path to its pattern, and unknown shapes to none", () => {
    expect(routePattern("/authz/check")).toBe("/authz/check");
    expect(routePattern("/.well-known/jwks.json")).toBe("/.well-known/jwks.json");
    expect(routePattern("/registry/v1/apps/notes")).toBe("/registry/v1/apps/:id");
    expect(routePattern("/registry/v1/apps/notes/subjects/user%40example.test/token")).toBe(
      "/registry/v1/apps/:id/subjects/:sub/token",
    );
    expect(routePattern("/admin/v1/apps")).toBe("/admin/v1/apps");
    expect(routePattern("/admin/v1/apps/notes/activate")).toBe("/admin/v1/apps/:id/activate");
    expect(routePattern("/admin/v1/roles/notes.reader/grants/dev-member")).toBe("/admin/v1/roles/:role/grants/:sub");
    expect(routePattern("/admin/v1/gateway/apps")).toBe("/admin/v1/gateway/apps");
    expect(routePattern("/admin/v1/apps/Not_An_Id")).toBeUndefined();
    expect(routePattern("/authz/check/extra")).toBeUndefined();
    expect(routePattern("/")).toBeUndefined();
  });
});
