/**
 * Database spans: a traced client turns each query inside a recording span into a CLIENT span that
 * carries only the allowlisted db attributes, never the SQL text, its parameters or an error message.
 */
import { EventEmitter } from "node:events";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_SPAN_ATTRIBUTES,
  redactSpan,
  sqlOperation,
  traceDatabaseClient,
  traceDatabasePool,
} from "../src/index.ts";
import { registerTestTelemetry, SpanKind, type TestTelemetry } from "../src/testing.ts";

const SECRET = "secret-value@example.com";

/** A stand-in for a `pg` client: promise form, callback form, failures with a SQLSTATE, submittables. */
class FakeClient {
  calls: unknown[][] = [];
  query(...args: unknown[]): unknown {
    this.calls.push(args);
    const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string }).text;
    const fail = text?.includes("missing_table");
    const err = Object.assign(new Error(`relation "missing_table" does not exist ${SECRET}`), { code: "42P01" });
    const res = { rows: [{ ok: true }], rowCount: 1 };
    const cb = args[args.length - 1];
    if (typeof cb === "function") {
      setImmediate(() => (fail ? cb(err) : cb(undefined, res)));
      return undefined;
    }
    if (typeof (args[0] as { submit?: unknown }).submit === "function") return args[0];
    return fail ? Promise.reject(err) : Promise.resolve(res);
  }
}

let telemetry: TestTelemetry;

beforeEach(() => {
  telemetry = registerTestTelemetry();
});

afterEach(async () => {
  await telemetry.shutdown();
});

function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  return trace.getTracer("test").startActiveSpan("GET /things", { kind: SpanKind.SERVER }, async (span) => {
    try {
      return await fn();
    } finally {
      span.end();
    }
  });
}

const dbSpans = () => telemetry.spans().filter((s) => s.kind === SpanKind.CLIENT);

describe("sqlOperation", () => {
  it("reads the first keyword past whitespace, comments and parentheses", () => {
    expect(sqlOperation("SELECT 1")).toBe("SELECT");
    expect(sqlOperation("  \n insert into t values ($1)")).toBe("INSERT");
    expect(sqlOperation("-- why\n/* what */ (select 1) union (select 2)")).toBe("SELECT");
    expect(sqlOperation("WITH x AS (SELECT 1) SELECT * FROM x")).toBe("WITH");
    expect(sqlOperation("begin")).toBe("BEGIN");
  });

  it("leaves out anything not on the list, and anything not text", () => {
    expect(sqlOperation(`${SECRET} SELECT`)).toBeUndefined();
    expect(sqlOperation("frobnicate everything")).toBeUndefined();
    expect(sqlOperation("/* unterminated SELECT")).toBeUndefined();
    expect(sqlOperation("-- only a comment")).toBeUndefined();
    expect(sqlOperation("")).toBeUndefined();
    expect(sqlOperation(undefined)).toBeUndefined();
    expect(sqlOperation(42)).toBeUndefined();
  });
});

describe("traceDatabaseClient", () => {
  it("runs a query inside a request in a CLIENT span, the child of the request's span", async () => {
    const client = traceDatabaseClient(new FakeClient(), { namespace: "core" });
    const res = await inRequest(() => client.query("SELECT * FROM apps WHERE id = $1", [SECRET]) as Promise<unknown>);
    expect(res).toEqual({ rows: [{ ok: true }], rowCount: 1 });

    const [db] = dbSpans();
    const server = telemetry.spans().find((s) => s.kind === SpanKind.SERVER);
    expect(db?.name).toBe("SELECT");
    expect(db?.parentSpanContext?.spanId).toBe(server?.spanContext().spanId);
    expect(db?.spanContext().traceId).toBe(server?.spanContext().traceId);
    expect(db?.attributes).toEqual({
      "db.system.name": "postgresql",
      "db.operation.name": "SELECT",
      "db.namespace": "core",
    });
    expect(db?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("records a failure's SQLSTATE, never its message, and rejects as before", async () => {
    const client = traceDatabaseClient(new FakeClient());
    await expect(
      inRequest(
        () => client.query({ text: "INSERT INTO missing_table VALUES ($1)", values: [SECRET] }) as Promise<unknown>,
      ),
    ).rejects.toMatchObject({ code: "42P01" });

    const [db] = dbSpans();
    expect(db?.name).toBe("INSERT");
    expect(db?.status.code).toBe(SpanStatusCode.ERROR);
    expect(db?.attributes).toEqual({
      "db.system.name": "postgresql",
      "db.operation.name": "INSERT",
      "error.type": "42P01",
      "db.response.status_code": "42P01",
    });
    expect(db?.events).toEqual([]);
    expect(JSON.stringify(db?.attributes)).not.toContain(SECRET);
  });

  it("traces the callback form, which pg-pool's pool.query uses, and keeps the request's context in the callback", async () => {
    const client = traceDatabaseClient(new FakeClient());
    const seen = await inRequest(
      () =>
        new Promise<{ err: unknown; spanName: string | undefined }>((resolve) => {
          client.query("COMMIT", undefined, (err: unknown) => {
            const active = trace.getActiveSpan() as unknown as { name?: string } | undefined;
            resolve({ err, spanName: active?.name });
          });
        }),
    );
    expect(seen).toEqual({ err: undefined, spanName: "GET /things" });
    expect(dbSpans().map((s) => s.name)).toEqual(["COMMIT"]);

    await inRequest(
      () =>
        new Promise<void>((resolve) => {
          client.query("DELETE FROM missing_table", (err: unknown) => {
            expect(err).toMatchObject({ code: "42P01" });
            resolve();
          });
        }),
    );
    expect(dbSpans()[1]?.attributes["error.type"]).toBe("42P01");
  });

  it("starts no span outside a request, so background polling doesn't open root traces", async () => {
    const client = traceDatabaseClient(new FakeClient());
    await client.query("SELECT 1");
    expect(telemetry.spans()).toEqual([]);
  });

  it("names an unknown statement after the system and records no operation", async () => {
    const client = traceDatabaseClient(new FakeClient());
    await inRequest(() => client.query(`${SECRET}`) as Promise<unknown>);
    const [db] = dbSpans();
    expect(db?.name).toBe("postgresql");
    expect(db?.attributes).toEqual({ "db.system.name": "postgresql" });
  });

  it("passes submittables and config callbacks through untraced", async () => {
    const fake = new FakeClient();
    const client = traceDatabaseClient(fake);
    const submittable = { text: "SELECT 1", submit: () => {} };
    await inRequest(async () => {
      expect(client.query(submittable)).toBe(submittable);
      await client.query({ text: "SELECT 1", callback: () => {} });
    });
    expect(fake.calls).toHaveLength(2);
    expect(dbSpans()).toEqual([]);
  });

  it("wraps a client once, however many times it is called", async () => {
    const fake = new FakeClient();
    traceDatabaseClient(fake);
    traceDatabaseClient(fake);
    await inRequest(() => fake.query("SELECT 1") as Promise<unknown>);
    expect(dbSpans()).toHaveLength(1);
  });

  it("exports only allowlisted attributes, under the operation's name", async () => {
    const client = traceDatabaseClient(new FakeClient(), { namespace: "core" });
    await inRequest(() => client.query("UPDATE missing_table SET x = $1", [SECRET]) as Promise<unknown>).catch(
      () => {},
    );
    const [db] = dbSpans();
    if (!db) throw new Error("no db span");
    const exported = redactSpan(db);
    expect(exported.name).toBe("UPDATE");
    expect(exported.attributes).toEqual(db.attributes);
    for (const key of Object.keys(exported.attributes)) expect(ALLOWED_SPAN_ATTRIBUTES.has(key)).toBe(true);
  });
});

describe("traceDatabasePool", () => {
  it("traces each client the pool connects", async () => {
    const pool = traceDatabasePool(
      new EventEmitter() as EventEmitter & { on(e: "connect", l: (c: FakeClient) => void): unknown },
    );
    const client = new FakeClient();
    pool.emit("connect", client);
    await inRequest(() => client.query("BEGIN") as Promise<unknown>);
    expect(dbSpans().map((s) => s.name)).toEqual(["BEGIN"]);
  });
});
