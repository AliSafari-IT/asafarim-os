import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../lib/core-api";
import { catalogFor, entryFlags, eventsAppFilter, schemaText } from "../lib/events";

const entry = (over: Partial<CatalogEntry> & { type: string }): CatalogEntry => ({
  publisher: null,
  schema: null,
  schemaStatus: "no_publisher",
  schemaUpdatedAt: null,
  schemaAppVersion: null,
  subscribers: [],
  ...over,
});

const created = entry({
  type: "notes.note.created.v1",
  publisher: { appId: "notes", version: "0.1.0", state: "active" },
  schema: { type: "object", required: ["id", "title"] },
  schemaStatus: "provided",
  schemaUpdatedAt: "2026-10-10T10:00:00.000Z",
  schemaAppVersion: "0.1.0",
  subscribers: [{ appId: "tasks", state: "active", handler: "/internal/events/note-created", consumer: "bound" }],
});
const deleted = entry({
  type: "notes.note.deleted.v1",
  publisher: { appId: "notes", version: "0.1.0", state: "active" },
  schemaStatus: "not_provided",
});
const dangling = entry({
  type: "billing.invoice.paid.v1",
  subscribers: [
    { appId: "tasks", state: "active", handler: "/internal/events/paid", consumer: "waiting_for_publisher" },
    { appId: "crm", state: "inactive", handler: "/internal/events/paid", consumer: "waiting_for_publisher" },
  ],
});
const all = [deleted, created, dangling];

describe("the Events page's ?app= filter", () => {
  it("accepts a valid app id and ignores anything else", () => {
    expect(eventsAppFilter("notes")).toBe("notes");
    for (const bad of [undefined, "", "Notes", "no tes", "../x", "a", "<script>", ["notes"], 3])
      expect(eventsAppFilter(bad), String(bad)).toBeUndefined();
  });

  it("without a filter: every type, sorted by type", () => {
    expect(catalogFor(all).map((e) => e.type)).toEqual([
      "billing.invoice.paid.v1",
      "notes.note.created.v1",
      "notes.note.deleted.v1",
    ]);
    expect(all[0]).toBe(deleted); // the input isn't reordered
  });

  it("keeps the types an app publishes or subscribes to", () => {
    expect(catalogFor(all, "notes").map((e) => e.type)).toEqual(["notes.note.created.v1", "notes.note.deleted.v1"]);
    expect(catalogFor(all, "tasks").map((e) => e.type)).toEqual(["billing.invoice.paid.v1", "notes.note.created.v1"]);
    expect(catalogFor(all, "crm").map((e) => e.type)).toEqual(["billing.invoice.paid.v1"]);
    expect(catalogFor(all, "nobody")).toEqual([]);
  });
});

describe("what the Events page flags", () => {
  it("a type with no publisher, and each subscriber waiting for one", () => {
    expect(entryFlags(dangling)).toEqual({ noPublisher: true, waiting: ["tasks", "crm"] });
  });

  it("nothing when the publisher is installed and consumers are bound", () => {
    expect(entryFlags(created)).toEqual({ noPublisher: false, waiting: [] });
    expect(entryFlags(deleted)).toEqual({ noPublisher: false, waiting: [] });
  });
});

describe("the schema as text", () => {
  it("is pretty-printed JSON, and empty without a schema", () => {
    expect(schemaText(created.schema)).toBe('{\n  "type": "object",\n  "required": [\n    "id",\n    "title"\n  ]\n}');
    expect(schemaText(null)).toBe("");
  });
});
