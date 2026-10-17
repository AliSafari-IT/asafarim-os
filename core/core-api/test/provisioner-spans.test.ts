/**
 * The provisioner's connections are traced (P6, ADR 0001 §9): a query it runs inside a recording
 * span is a CLIENT span with the operation and the provisioner database's name, and no span carries
 * the SQL text, its parameters or a role's password. No database: `newClient` hands back a
 * stand-in client.
 */
import { traceEventHandler } from "@asafarim/telemetry";
import { SpanKind, registerTestTelemetry, type TestTelemetry } from "@asafarim/telemetry/testing";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureRole } from "../src/provision.ts";
import { createProvisioner } from "../src/server.ts";

const URL = "postgres://provisioner:pw@app-db:5432/postgres";
const PASSWORD = "s3cret-app-password";

class FakeClient {
  connected = false;
  readonly seen: string[] = [];
  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    this.seen.push(text);
    if (text.startsWith("SELECT format(")) {
      return Promise.resolve({
        rows: [{ sql: `CREATE ROLE "app_x" LOGIN PASSWORD '${String(values?.[2])}'` }],
        rowCount: 1,
      });
    }
    if (text.startsWith("CREATE DATABASE")) {
      return Promise.reject(Object.assign(new Error(`database "app_x" already exists`), { code: "42P04" }));
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
}

/** Run `fn` inside a recording span (the way a traced admin request does). */
const inSpan = <T>(fn: () => Promise<T>) => traceEventHandler(fn)({ id: "1", type: "test.request" });

let telemetry: TestTelemetry;
let clients: FakeClient[];
const provisioner = () =>
  createProvisioner(URL, (connectionString) => {
    expect(connectionString).toBe(URL);
    const c = new FakeClient();
    clients.push(c);
    return c as unknown as pg.Client;
  });

beforeEach(() => {
  telemetry = registerTestTelemetry();
  clients = [];
});
afterEach(async () => {
  await telemetry.shutdown();
});

const dbSpans = () => telemetry.spans().filter((s) => s.kind === SpanKind.CLIENT);
/** Everything a span would export (its name, attributes, status and events), as text. */
const exported = (spans: ReturnType<TestTelemetry["spans"]>) =>
  JSON.stringify(spans.map((s) => ({ name: s.name, attributes: s.attributes, status: s.status, events: s.events })));

describe("createProvisioner", () => {
  it("opens a new connected client per call", async () => {
    const open = provisioner();
    const a = await open();
    const b = await open();
    expect(a).not.toBe(b);
    expect(clients.map((c) => c.connected)).toEqual([true, true]);
  });

  it("traces its queries: operation and database name, never the SQL, its values or a password", async () => {
    const open = provisioner();
    await inSpan(async () => ensureRole(await open(), "app_x", PASSWORD));

    expect(clients[0]?.seen.some((t) => t.includes(PASSWORD))).toBe(true); // the password did reach the client
    const spans = dbSpans();
    expect(spans.map((s) => s.name)).toEqual(["SELECT", "SELECT", "CREATE"]);
    for (const s of spans) {
      expect(s.attributes).toEqual({
        "db.system.name": "postgresql",
        "db.operation.name": s.name,
        "db.namespace": "postgres",
      });
    }
    expect(exported(telemetry.spans())).not.toContain(PASSWORD);
  });

  it("records a failure's SQLSTATE, not its message", async () => {
    const open = provisioner();
    await expect(inSpan(async () => (await open()).query("CREATE DATABASE app_x"))).rejects.toThrow();

    const spans = dbSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes["db.response.status_code"]).toBe("42P04");
    expect(exported(spans)).not.toContain("already exists");
  });

  it("leaves queries outside a span untraced", async () => {
    await (await provisioner()()).query("SELECT 1");
    expect(telemetry.spans()).toEqual([]);
  });
});
