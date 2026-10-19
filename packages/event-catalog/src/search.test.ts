import { describe, expect, it } from "vitest";
import type { SearchableEntry } from "./search.ts";
import {
  MAX_QUERY_LENGTH,
  eventsQuery,
  fieldWords,
  queryTerms,
  schemaTexts,
  searchCatalog,
  stem,
  words,
} from "./search.ts";

/** core-api's full entry shape: the search must keep the fields it doesn't read. */
interface CatalogEntry extends SearchableEntry {
  publisher: { appId: string; version: string; state: string } | null;
  schemaStatus: "provided" | "not_provided" | "no_publisher";
  schemaUpdatedAt: string | null;
  schemaAppVersion: string | null;
  subscribers: { appId: string; state: string; handler: string; consumer: "bound" | "waiting_for_publisher" }[];
}

const entry = (over: Partial<CatalogEntry> & { type: string }): CatalogEntry => ({
  publisher: null,
  schema: null,
  schemaStatus: "no_publisher",
  schemaUpdatedAt: null,
  schemaAppVersion: null,
  subscribers: [],
  ...over,
});

const shipped = entry({
  type: "shop.order.shipped.v1",
  publisher: { appId: "shop", version: "1.2.0", state: "active" },
  schemaStatus: "provided",
  schema: {
    title: "shop.order.shipped.v1",
    description: "An order left the warehouse.",
    type: "object",
    properties: {
      orderId: { type: "string", description: "The order id" },
      carrier: { type: "string", enum: [{ description: "never read: inside enum" }] },
      parcels: { type: "array", items: { type: "object", properties: { trackingCode: { type: "string" } } } },
    },
  },
  subscribers: [{ appId: "crm", state: "active", handler: "/internal/events/shipped", consumer: "bound" }],
});
const dispatch = entry({
  type: "warehouse.parcel.dispatched.v1",
  publisher: { appId: "warehouse", version: "0.3.0", state: "active" },
  schemaStatus: "provided",
  schema: { description: "A parcel left for the customer: its shipment is on its way.", type: "object" },
});
const noteCreated = entry({
  type: "notes.note.created.v1",
  publisher: { appId: "notes", version: "0.1.0", state: "active" },
  schemaStatus: "provided",
  schema: {
    title: "notes.note.created.v1",
    description: "A note was created.",
    properties: { author: { type: "string", description: "The subject (person) who created it" } },
  },
});
const invoicePaid = entry({
  type: "billing.invoice.paid.v1",
  subscribers: [
    { appId: "tasks", state: "active", handler: "/internal/events/paid", consumer: "waiting_for_publisher" },
  ],
});
const catalog = [invoicePaid, noteCreated, shipped, dispatch];
const types = (q: string) => searchCatalog(catalog, q).map((h) => h.entry.type);

describe("the Events page's ?q= search", () => {
  it("accepts a string, trimmed and cut to the maximum length; anything else is nothing", () => {
    expect(eventsQuery("  order shipped ")).toBe("order shipped");
    expect(eventsQuery("x".repeat(MAX_QUERY_LENGTH + 50))).toHaveLength(MAX_QUERY_LENGTH);
    for (const none of [undefined, "", "   ", ["order"], 3, null])
      expect(eventsQuery(none), String(none)).toBeUndefined();
  });
});

describe("words and stems", () => {
  it("splits on punctuation and camelCase, lower-cased", () => {
    expect(words("shop.order.shipped.v1")).toEqual(["shop", "order", "shipped", "v1"]);
    expect(words("orderId trackingCode")).toEqual(["order", "id", "tracking", "code"]);
    expect(words("Éclair-über")).toEqual(["éclair", "über"]);
  });

  it("folds common suffixes without eating short words", () => {
    expect(["ships", "shipped", "shipping"].map(stem)).toEqual(["ship", "shipp", "shipp"]);
    expect(stem("notes")).toBe("note");
    expect(stem("boxes")).toBe("box");
    expect(stem("address")).toBe("address");
    expect(stem("bus")).toBe("bus");
    expect(stem("red")).toBe("red");
  });

  it("keeps a field word as written next to its stem, once", () => {
    expect(fieldWords(["speed", "notes", "bus"])).toEqual(["spe", "speed", "note", "notes", "bus"]);
    expect(fieldWords(["shop.order.shipped.v1"])).toEqual(["shop", "order", "shipp", "shipped", "v1"]);
    expect(fieldWords([])).toEqual([]);
  });

  it("drops question words, unless the query has nothing else", () => {
    expect(queryTerms("Which app emits something when an order ships?")).toEqual(["order", "ship"]);
    expect(queryTerms("which event")).toEqual(["which", "event"]);
    expect(queryTerms("order ORDERS")).toEqual(["order"]);
    expect(queryTerms("  ?! ")).toEqual([]);
  });
});

describe("what a schema contributes", () => {
  it("its own title and description, then every property name, title and description below it", () => {
    expect(schemaTexts(shipped.schema)).toEqual({
      description: ["shop.order.shipped.v1", "An order left the warehouse."],
      property: ["orderId", "carrier", "parcels", "The order id", "trackingCode"],
    });
    expect(schemaTexts(null)).toEqual({ description: [], property: [] });
  });

  it("stops on a deeply nested or cyclic-looking schema", () => {
    let deep: Record<string, unknown> = { description: "bottom" };
    for (let i = 0; i < 50; i++) deep = { properties: { [`p${i}`]: deep } };
    const texts = schemaTexts(deep);
    expect(texts.property).not.toContain("bottom");
    expect(texts.property.length).toBeLessThan(20);
  });
});

describe("searching the catalog", () => {
  it("answers the ADR's question: which app emits something when an order ships?", () => {
    const hits = searchCatalog(catalog, "Which app emits something when an order ships?");
    expect(hits.map((h) => h.entry.type)).toEqual(["shop.order.shipped.v1"]);
    expect(hits[0]).toMatchObject({ score: 8, matched: ["type", "description", "property"] });
  });

  it("finds a type through its schema's description, ranked under a type match", () => {
    expect(types("shipment")).toEqual(["warehouse.parcel.dispatched.v1"]);
    expect(types("parcel")).toEqual(["warehouse.parcel.dispatched.v1", "shop.order.shipped.v1"]);
  });

  it("finds by app id, publisher or subscriber", () => {
    expect(types("crm")).toEqual(["shop.order.shipped.v1"]);
    expect(types("tasks")).toEqual(["billing.invoice.paid.v1"]);
    expect(searchCatalog(catalog, "crm")[0]?.matched).toEqual(["app"]);
  });

  it("matches word forms both ways", () => {
    expect(types("note create")).toEqual(["notes.note.created.v1"]);
    expect(types("creation")).toEqual(["notes.note.created.v1"]);
    expect(types("tracking")).toEqual(["shop.order.shipped.v1"]);
  });

  it("finds a word whose stem is only three letters, in any form", () => {
    const speed = entry({
      type: "fleet.truck.speed.v1",
      publisher: { appId: "fleet", version: "1.0.0", state: "active" },
      schemaStatus: "provided",
      schema: { description: "A truck reported its speed.", properties: { named: { type: "string" } } },
    });
    const all = [...catalog, speed];
    for (const q of ["speed", "speeds", "speeding", "speedy truck"])
      expect(
        searchCatalog(all, q).map((h) => h.entry.type),
        q,
      ).toEqual(["fleet.truck.speed.v1"]);
    // "named" stems to "nam": "names" and "naming" find it as a property.
    for (const q of ["names", "naming", "named"])
      expect(searchCatalog(all, q)[0], q).toMatchObject({ entry: speed, matched: ["property"] });
    // Unrelated words still miss.
    expect(searchCatalog(all, "spending")).toEqual([]);
  });

  it("needs every word, and finds nothing for nothing", () => {
    expect(types("order paid")).toEqual([]);
    expect(types("zzz")).toEqual([]);
    expect(types("?!")).toEqual([]);
    expect(searchCatalog([], "order")).toEqual([]);
  });

  it("ignores text inside enum, const, default and examples", () => {
    expect(types("never read")).toEqual([]);
  });

  it("keeps the type order on equal scores and leaves the input alone", () => {
    expect(types("v1")).toEqual(catalog.map((e) => e.type).sort());
    expect(catalog[0]).toBe(invoicePaid);
  });

  it("hands back the caller's own entries, with the fields the search doesn't read", () => {
    const [hit] = searchCatalog(catalog, "order shipped");
    expect(hit!.entry).toBe(shipped);
    expect(hit!.entry.schemaStatus).toBe("provided");
  });

  it("reads an app id that isn't a string as no words, instead of throwing", () => {
    const odd = { type: "x.y.created", publisher: { appId: 7 }, schema: null, subscribers: [{ appId: null }] };
    expect(searchCatalog([odd as unknown as SearchableEntry], "created").map((h) => h.entry.type)).toEqual([
      "x.y.created",
    ]);
  });
});
