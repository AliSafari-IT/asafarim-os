import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OUTBOX_SQL,
  ULID_PATTERN,
  UndeclaredEventError,
  EventValidationError,
  backoffDelay,
  compileEventSchema,
  createEvent,
  createPublisher,
  loadSchemas,
  streamName,
  streamSubjects,
  ulid,
  type Queryable,
} from "../src/index.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["id", "title", "createdAt"],
  properties: {
    id: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1, maxLength: 200 },
    createdAt: { type: "string", format: "date-time" },
  },
};
const manifest = {
  id: "notes",
  events: { publishes: [{ type: "notes.note.created.v1", schema: "./events/notes.note.created.v1.json" }] },
};
const schemas = { "./events/notes.note.created.v1.json": schema };
const good = { id: "1", title: "Hello", createdAt: "2026-10-09T12:00:00.000Z" };

/** A transaction stand-in that records every query. */
function recorder() {
  const queries: { text: string; values?: unknown[] }[] = [];
  const tx: Queryable = {
    query: async (text, values) => {
      queries.push({ text, values });
      return { rows: [], rowCount: 1 };
    },
  };
  return { tx, queries };
}

describe("ulid", () => {
  it("is 26 Crockford base32 characters, time first", () => {
    // The spec's own example: 1469918176385 ms encodes as 01ARYZ6S41.
    const id = ulid(1469918176385, new Uint8Array(10).fill(255));
    expect(id).toMatch(ULID_PATTERN);
    expect(id).toBe("01ARYZ6S41ZZZZZZZZZZZZZZZZ");
    expect(ulid(1469918176386, new Uint8Array(10)) > id).toBe(true);
  });

  it("is unique", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => ulid()));
    expect(ids.size).toBe(1000);
  });
});

describe("createEvent (CloudEvents 1.0, structured JSON)", () => {
  it("builds every required attribute, the subject and the traceparent extension", () => {
    const now = new Date("2026-10-09T12:00:00.000Z");
    const e = createEvent({
      source: "notes",
      type: "notes.note.created.v1",
      subject: "42",
      data: good,
      now,
      traceparent: TRACEPARENT,
    });
    expect(e).toEqual({
      specversion: "1.0",
      id: expect.stringMatching(ULID_PATTERN),
      source: "asafarim://notes",
      type: "notes.note.created.v1",
      subject: "42",
      time: "2026-10-09T12:00:00.000Z",
      datacontenttype: "application/json",
      data: good,
      traceparent: TRACEPARENT,
    });
    expect(Object.keys(createEvent({ source: "notes", type: "notes.note.created.v1", data: {} }))).not.toContain(
      "traceparent",
    );
  });

  it("refuses a type outside the app's namespace, a malformed type, a bad traceparent", () => {
    expect(() => createEvent({ source: "notes", type: "tasks.task.created.v1", data: {} })).toThrow(/own namespace/);
    expect(() => createEvent({ source: "notes", type: "notes.created", data: {} })).toThrow(/must be/);
    expect(() => createEvent({ source: "Notes!", type: "notes.note.created.v1", data: {} })).toThrow(/app id/);
    expect(() =>
      createEvent({ source: "notes", type: "notes.note.created.v1", data: {}, traceparent: "00-0-0-01" }),
    ).toThrow(/traceparent/);
    expect(() =>
      createEvent({
        source: "notes",
        type: "notes.note.created.v1",
        data: {},
        traceparent: `00-${"0".repeat(32)}-00f067aa0ba902b7-01`,
      }),
    ).toThrow(/traceparent/);
  });
});

describe("publish (validated, then one outbox row in the caller's transaction)", () => {
  it("writes exactly one outbox row holding the envelope", async () => {
    const { tx, queries } = recorder();
    const p = createPublisher({ manifest, schemas, now: () => new Date("2026-10-09T12:00:00.000Z") });
    const e = await p.publish(tx, "notes.note.created.v1", good, { subject: "1", traceparent: TRACEPARENT });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toMatch(/^INSERT INTO asafarim_outbox \(id, type, envelope\)/);
    expect(queries[0]!.values).toEqual([e.id, "notes.note.created.v1", JSON.stringify(e)]);
    expect(JSON.parse(queries[0]!.values![2] as string)).toMatchObject({
      source: "asafarim://notes",
      subject: "1",
      data: good,
      traceparent: TRACEPARENT,
    });
  });

  it("an invalid payload throws BEFORE the outbox insert", async () => {
    const { tx, queries } = recorder();
    const p = createPublisher({ manifest, schemas });
    for (const bad of [
      { ...good, title: "" }, // minLength
      { ...good, createdAt: "yesterday" }, // format
      { id: "1", title: "x" }, // required
      { ...good, extra: true }, // additionalProperties
      "not an object",
    ]) {
      await expect(p.publish(tx, "notes.note.created.v1", bad)).rejects.toBeInstanceOf(EventValidationError);
    }
    await expect(p.publish(tx, "notes.note.created.v1", { ...good, title: "" })).rejects.toThrow(/\/title/);
    expect(queries).toHaveLength(0);
  });

  it("a type the manifest doesn't publish throws BEFORE the outbox insert", async () => {
    const { tx, queries } = recorder();
    const p = createPublisher({ manifest, schemas });
    await expect(p.publish(tx, "notes.note.deleted.v1", good)).rejects.toBeInstanceOf(UndeclaredEventError);
    await expect(p.publish(tx, "tasks.task.created.v1", good)).rejects.toThrow(/doesn't declare/);
    expect(queries).toHaveLength(0);
  });

  it("refuses to start without a schema for a declared type, or with one that doesn't compile", () => {
    expect(() => createPublisher({ manifest, schemas: {} })).toThrow(/no JSON Schema given/);
    expect(() =>
      createPublisher({ manifest, schemas: { "./events/notes.note.created.v1.json": { type: "nonsense" } } }),
    ).toThrow(/doesn't compile/);
  });

  it("loadSchemas reads the files the manifest references, and nothing outside the app", () => {
    const fixtures = path.join(ROOT, "test/fixtures");
    expect(loadSchemas(manifest, fixtures)).toEqual(schemas);
    expect(() =>
      loadSchemas({ id: "x", events: { publishes: [{ type: "x.a.b.v1", schema: "./../../package.json" }] } }, fixtures),
    ).toThrow(/outside the app/);
  });
});

describe("streams", () => {
  it("APP_<ID> on <id>.>", () => {
    expect(streamName("notes")).toBe("APP_NOTES");
    expect(streamName("time-line")).toBe("APP_TIME_LINE");
    expect(streamSubjects("notes")).toEqual(["notes.>"]);
    expect(() => streamName("a.>")).toThrow(/app id/);
  });
});

describe("relay backoff", () => {
  it("is capped exponential", () => {
    expect([0, 1, 2, 3, 4, 10, 100].map((n) => backoffDelay(n, 250, 10_000))).toEqual([
      0, 250, 500, 1000, 2000, 10_000, 10_000,
    ]);
  });
});

describe("the outbox migrations", () => {
  it("the plain-SQL and Drizzle files carry the same DDL as OUTBOX_SQL", () => {
    const strip = (s: string) =>
      s
        .split("\n")
        .filter((l) => !l.startsWith("--"))
        .join("\n")
        .trim();
    expect(strip(readFileSync(path.join(ROOT, "sql/001_outbox.sql"), "utf8"))).toBe(OUTBOX_SQL.trim());
    expect(strip(readFileSync(path.join(ROOT, "drizzle/0000_asafarim_outbox.sql"), "utf8"))).toBe(OUTBOX_SQL.trim());
  });
});

describe("compileEventSchema (the setup core-api checks uploaded schemas with)", () => {
  it("compiles a schema with formats, and the same $id twice (a fresh ajv each time)", () => {
    const withId = { ...schema, $id: "https://example.test/notes.v1.json" };
    expect(compileEventSchema(withId)({ id: "1", title: "t", createdAt: "2026-10-10T12:00:00Z" })).toBe(true);
    expect(() => compileEventSchema(withId)).not.toThrow();
  });

  it("refuses what the publisher would refuse (strict mode: unknown keywords, bad types)", () => {
    expect(() => compileEventSchema({ type: "object", madeUp: true })).toThrow();
    expect(() => compileEventSchema({ type: "nope" })).toThrow();
  });
});
