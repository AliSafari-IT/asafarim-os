/**
 * core-api's database spans against a real Postgres and the real `pg` pool: each query inside a
 * traced request, through `pool.query` or a checked-out client's transaction, is a CLIENT span of
 * the request's trace named after its operation, with the SQLSTATE on failure; nothing outside a
 * request is traced, and no span carries SQL text or parameters.
 *
 * Needs CORE_API_TEST_ADMIN_URL (see registry.integration.test.ts); it only reads and rolls back.
 * Skipped without it, except when CORE_API_TEST_REQUIRED is set (CI), where it fails instead.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { ALLOWED_SPAN_ATTRIBUTES, databaseNameOf, traceDatabasePool, traceHttpHandler } from "@asafarim/telemetry";
import { SpanKind, registerTestTelemetry, type TestTelemetry } from "@asafarim/telemetry/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN_URL = process.env.CORE_API_TEST_ADMIN_URL;
if (process.env.CORE_API_TEST_REQUIRED && !ADMIN_URL) throw new Error("CORE_API_TEST_ADMIN_URL must be set");

const SECRET = "secret-parameter-value";
/** `STATUS_ERROR` (core-api doesn't depend on @opentelemetry/api itself). */
const STATUS_ERROR = 2;

describe.skipIf(!ADMIN_URL)("database spans (real Postgres)", () => {
  let pool: pg.Pool;
  let telemetry: TestTelemetry;

  beforeAll(() => {
    pool = traceDatabasePool(new pg.Pool({ connectionString: ADMIN_URL, max: 2 }), {
      namespace: databaseNameOf(ADMIN_URL ?? ""),
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(() => {
    telemetry = registerTestTelemetry();
  });

  afterEach(async () => {
    await telemetry.shutdown();
  });

  /**
   * Run `fn` inside a real traced request, as core-api's handler would: a node:http server wrapped
   * in `traceHttpHandler`. Resolves with what `fn` returned and the request span's ids; rejects with
   * what `fn` threw.
   */
  async function inRequest<T>(fn: () => Promise<T>): Promise<{ result: T; traceId: string; spanId: string }> {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
    const server = createServer(
      traceHttpHandler(
        async (_req, res) => {
          try {
            outcome = { ok: true, value: await fn() };
          } catch (error) {
            outcome = { ok: false, error };
          }
          res.writeHead(204);
          res.end();
        },
        { route: () => "/admin/v1/apps" },
      ),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/v1/apps`, { method: "POST" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await vi.waitFor(() => expect(telemetry.spans().some((s) => s.kind === SpanKind.SERVER)).toBe(true));
    const request = telemetry.spans().find((s) => s.kind === SpanKind.SERVER);
    if (!outcome || !request) throw new Error("the request didn't run");
    if (!outcome.ok) throw outcome.error;
    return { result: outcome.value, traceId: request.spanContext().traceId, spanId: request.spanContext().spanId };
  }

  const dbSpans = () => telemetry.spans().filter((s) => s.kind === SpanKind.CLIENT);

  it("traces pool.query and a checked-out client's transaction as children of the request", async () => {
    const { result, traceId, spanId } = await inRequest(async () => {
      const r = await pool.query<{ v: string }>("SELECT $1::text AS v", [SECRET]);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("CREATE TEMP TABLE db_spans_t (v text) ON COMMIT DROP");
        await client.query("INSERT INTO db_spans_t VALUES ($1)", [SECRET]);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      return r.rows[0]?.v;
    });
    expect(result).toBe(SECRET);

    const spans = dbSpans();
    expect(spans.map((s) => s.name)).toEqual(["SELECT", "BEGIN", "CREATE", "INSERT", "ROLLBACK"]);
    for (const span of spans) {
      expect(span.spanContext().traceId).toBe(traceId);
      expect(span.parentSpanContext?.spanId).toBe(spanId);
      expect(span.attributes["db.system.name"]).toBe("postgresql");
      expect(span.attributes["db.namespace"]).toBe(databaseNameOf(ADMIN_URL ?? ""));
      for (const key of Object.keys(span.attributes)) expect(ALLOWED_SPAN_ATTRIBUTES.has(key)).toBe(true);
      expect(JSON.stringify(span.attributes)).not.toContain(SECRET);
    }
  });

  it("records the SQLSTATE of a failed query, and the query still rejects", async () => {
    await expect(inRequest(() => pool.query("SELECT * FROM db_spans_no_such_table"))).rejects.toMatchObject({
      code: "42P01",
    });
    const [span] = dbSpans();
    expect(span?.name).toBe("SELECT");
    expect(span?.status.code).toBe(STATUS_ERROR);
    expect(span?.attributes["error.type"]).toBe("42P01");
    expect(span?.attributes["db.response.status_code"]).toBe("42P01");
  });

  it("traces nothing outside a request", async () => {
    await pool.query("SELECT 1");
    expect(telemetry.spans()).toEqual([]);
  });
});
