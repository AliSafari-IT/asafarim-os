/**
 * The app's pool is traced (P6, ADR 0001 §9): a query run inside a recording span by a client the
 * pool connected is a CLIENT span with the operation and this app's database name, and no span
 * carries the SQL text or its parameters. No database: the pool's `connect` event is fed a
 * stand-in client, which is exactly what `pg` does with each new connection.
 */
import { EventEmitter } from "node:events";
import { traceEventHandler } from "@asafarim/telemetry";
import { SpanKind, registerTestTelemetry, type TestTelemetry } from "@asafarim/telemetry/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNotesPool } from "../lib/db";

const SECRET = "a private note body";

class FakeClient extends EventEmitter {
  query(..._args: unknown[]): Promise<{ rows: unknown[] }> {
    return Promise.resolve({ rows: [] });
  }
}

/** Run `fn` inside a recording span (the way a traced request or event handler does). */
const inSpan = <T>(fn: () => Promise<T>) => traceEventHandler(fn)({ id: "1", type: "test.request" });

let telemetry: TestTelemetry;
beforeEach(() => {
  telemetry = registerTestTelemetry();
});
afterEach(async () => {
  await telemetry.shutdown();
});

describe("createNotesPool", () => {
  it("traces each client it connects: operation and database name, never the SQL or its values", async () => {
    const pool = createNotesPool("postgres://notes_app:pw@app-db:5432/app_notes");
    const client = new FakeClient();
    pool.emit("connect", client);

    await inSpan(() => client.query("INSERT INTO notes (author, title, body) VALUES ($1, $2, $3)", ["a", "t", SECRET]));

    const db = telemetry.spans().filter((s) => s.kind === SpanKind.CLIENT);
    expect(db).toHaveLength(1);
    expect(db[0]?.name).toBe("INSERT");
    expect(db[0]?.attributes).toEqual({
      "db.system.name": "postgresql",
      "db.operation.name": "INSERT",
      "db.namespace": "app_notes",
    });
    expect(JSON.stringify(db[0]?.attributes)).not.toContain(SECRET);
    await pool.end();
  });

  it("leaves queries outside a span untraced", async () => {
    const pool = createNotesPool("postgres://notes_app:pw@app-db:5432/app_notes");
    const client = new FakeClient();
    pool.emit("connect", client);

    await client.query("SELECT 1");

    expect(telemetry.spans()).toEqual([]);
    await pool.end();
  });
});
