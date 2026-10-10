import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.ts";
import { MAX_SCHEMA_BYTES, checkEventSchemas } from "../src/event-schemas.ts";

const manifest = {
  events: {
    publishes: [{ type: "notes.note.created.v1" }, { type: "notes.note.deleted.v1" }],
    subscribes: [{ type: "crm.contact.created.v1" }],
  },
};

const schema = (title = "x") => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" }, at: { type: "string", format: "date-time" } },
  title,
});

function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error("expected a refusal");
}

describe("checkEventSchemas", () => {
  it("accepts exactly the published types, each a compiling schema", () => {
    const out = checkEventSchemas(manifest, {
      schemas: { "notes.note.deleted.v1": schema("d"), "notes.note.created.v1": schema("c") },
    });
    expect(Object.keys(out)).toEqual(["notes.note.created.v1", "notes.note.deleted.v1"]);
    expect(out["notes.note.created.v1"]).toMatchObject({ title: "c" });
  });

  it("an app that publishes nothing uploads an empty set", () => {
    expect(checkEventSchemas({ events: { subscribes: [{ type: "a.b.v1" }] } }, { schemas: {} })).toEqual({});
    expect(checkEventSchemas(null, { schemas: {} })).toEqual({});
  });

  it("refuses a body that isn't { schemas: { … } }", () => {
    for (const body of [null, [], "x", {}, { schemas: [] }, { schemas: "x" }]) {
      expect(refusal(() => checkEventSchemas(manifest, body)).code).toBe("invalid_event_schemas");
    }
  });

  it("a missing type is refused, naming it", () => {
    const err = refusal(() => checkEventSchemas(manifest, { schemas: { "notes.note.created.v1": schema() } }));
    expect(err.code).toBe("invalid_event_schemas");
    expect(err.status).toBe(400);
    expect(err.message).toContain("notes.note.deleted.v1");
    expect(err.details).toEqual([{ type: "notes.note.deleted.v1", message: expect.stringContaining("missing") }]);
  });

  it("an extra type (not published, or another app's, or a subscribed one) is refused, naming it", () => {
    const err = refusal(() =>
      checkEventSchemas(manifest, {
        schemas: {
          "notes.note.created.v1": schema(),
          "notes.note.deleted.v1": schema(),
          "crm.contact.created.v1": schema(),
        },
      }),
    );
    expect(err.code).toBe("invalid_event_schemas");
    expect(err.details).toEqual([{ type: "crm.contact.created.v1", message: expect.stringContaining("extra") }]);
  });

  it("a schema that isn't an object, or doesn't compile, is refused, naming the type", () => {
    for (const bad of [[], "string", 3, null, { type: "nope" }, { type: "object", notAKeyword: 1 }]) {
      const err = refusal(() =>
        checkEventSchemas(manifest, { schemas: { "notes.note.created.v1": bad, "notes.note.deleted.v1": schema() } }),
      );
      expect(err.code).toBe("invalid_event_schemas");
      expect(err.details).toEqual([{ type: "notes.note.created.v1", message: expect.any(String) }]);
    }
  });

  it("a schema over 64 KiB is 413 payload_too_large, naming the type", () => {
    const big = { ...schema(), description: "x".repeat(MAX_SCHEMA_BYTES) };
    const err = refusal(() =>
      checkEventSchemas(manifest, { schemas: { "notes.note.created.v1": schema(), "notes.note.deleted.v1": big } }),
    );
    expect(err.code).toBe("payload_too_large");
    expect(err.status).toBe(413);
    expect(err.message).toContain("notes.note.deleted.v1");
  });

  it("a schema just under the limit is accepted", () => {
    const base = JSON.stringify({ ...schema(), description: "" }).length;
    const fits = { ...schema(), description: "x".repeat(MAX_SCHEMA_BYTES - base) };
    expect(Buffer.byteLength(JSON.stringify(fits))).toBe(MAX_SCHEMA_BYTES);
    expect(() =>
      checkEventSchemas(manifest, { schemas: { "notes.note.created.v1": fits, "notes.note.deleted.v1": schema() } }),
    ).not.toThrow();
  });
});
