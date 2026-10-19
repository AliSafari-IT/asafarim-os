import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  asCatalog,
  catalogFor,
  eventsCommand,
  formatCatalog,
  formatSchema,
  formatSearch,
  parseEventsArgs,
} from "./events.ts";

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "events-cmd-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  return root;
}

const ENV = { CORE_API_URL: "http://localhost:4020", CORE_API_ADMIN_TOKEN: "tok" };

const SCHEMA = { title: "A note was created", type: "object", properties: { noteId: { type: "string" } } };

const CREATED = {
  type: "notes.note.created.v1",
  publisher: { appId: "notes", version: "1.2.0", state: "active" },
  schema: SCHEMA,
  schemaStatus: "provided",
  schemaUpdatedAt: "2026-10-12T09:30:00.000Z",
  schemaAppVersion: "1.2.0",
  subscribers: [{ appId: "search", state: "active", handler: "/events/note-created", consumer: "bound" }],
};
const DELETED = {
  type: "notes.note.deleted.v1",
  publisher: { appId: "notes", version: "1.2.0", state: "active" },
  schema: null,
  schemaStatus: "not_provided",
  schemaUpdatedAt: null,
  schemaAppVersion: null,
  subscribers: [],
};
const PUBLISHED = {
  type: "docs.page.published",
  publisher: null,
  schema: null,
  schemaStatus: "no_publisher",
  schemaUpdatedAt: null,
  schemaAppVersion: null,
  subscribers: [{ appId: "notes", state: "active", handler: "/events/page", consumer: "waiting_for_publisher" }],
};

/** A fetch that answers every call with one reply; records the calls. */
function reply(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("platform events: arguments", () => {
  it("takes --app <id> and --json at most once each", () => {
    expect(parseEventsArgs([])).toEqual({ action: "list", json: false });
    expect(parseEventsArgs(["--json"])).toEqual({ action: "list", json: true });
    expect(parseEventsArgs(["--app", "notes", "--json"])).toEqual({ action: "list", app: "notes", json: true });
    expect(parseEventsArgs(["--app", "core"])).toEqual({ action: "list", app: "core", json: false });
    expect(parseEventsArgs(["--json", "--json"])).toBeNull();
    expect(parseEventsArgs(["--app", "notes", "--app", "docs"])).toBeNull();
    expect(parseEventsArgs(["--app"])).toBeNull();
    expect(parseEventsArgs(["--app", "Not An Id"])).toBeNull();
    expect(parseEventsArgs(["notes"])).toBeNull();
    expect(parseEventsArgs(["--search", "x"])).toBeNull();
  });

  it("takes schema <type> with exactly one valid type", () => {
    expect(parseEventsArgs(["schema", "notes.note.created.v1"])).toEqual({
      action: "schema",
      type: "notes.note.created.v1",
    });
    expect(parseEventsArgs(["schema"])).toBeNull();
    expect(parseEventsArgs(["schema", "notes"])).toBeNull();
    expect(parseEventsArgs(["schema", "../etc"])).toBeNull();
    expect(parseEventsArgs(["schema", "a.b", "c.d"])).toBeNull();
    expect(parseEventsArgs(["schema", "a.b", "--json"])).toBeNull();
  });

  it("prints the usage (null) for anything else, before any request", async () => {
    const fetchImpl = reply(200, { events: [] });
    expect(await eventsCommand(["--nope"], workspace(), ENV, fetchImpl)).toBeNull();
    expect(await eventsCommand(["schema"], workspace(), ENV, fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("platform events: the catalog", () => {
  it("prints one row per type, sorted by type, with the admin token", async () => {
    const fetchImpl = reply(200, { events: [DELETED, CREATED, PUBLISHED] });
    const r = await eventsCommand([], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(true);
    expect(r?.stdout).toBe(true);
    const text = r!.lines.join("\n");
    expect(text).toMatch(/^Type\s+Publisher\s+Schema\s+Subscribers$/m);
    expect(text).toMatch(/^docs\.page\.published\s+–\s+no publisher\s+notes \(waiting\)$/m);
    expect(text).toMatch(/^notes\.note\.created\.v1\s+notes@1\.2\.0\s+provided\s+search$/m);
    expect(text).toMatch(/^notes\.note\.deleted\.v1\s+notes@1\.2\.0\s+not provided\s+–$/m);
    expect(text.indexOf("docs.page")).toBeLessThan(text.indexOf("notes.note.created"));
    expect(text.indexOf("notes.note.created")).toBeLessThan(text.indexOf("notes.note.deleted"));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4020/admin/v1/events");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("adds notes for types nobody publishes and types without a schema", () => {
    const lines = formatCatalog(catalogFor([CREATED, DELETED, PUBLISHED] as never));
    expect(lines).toContain("No publisher (a warning; the subscribers wait):");
    expect(lines).toContain(
      "  docs.page.published: subscribed to by notes (waiting), but no installed app publishes it",
    );
    expect(lines).toContain("No schema yet (see pnpm platform events schema <type>):");
    expect(lines).toContain("  notes.note.deleted.v1: notes@1.2.0 publishes it but hasn't uploaded a schema");
  });

  it("has no notes when every type has a publisher and a schema", () => {
    expect(formatCatalog([CREATED] as never)).toHaveLength(2);
  });

  it("--app keeps the types the app publishes or subscribes to", async () => {
    const all = [CREATED, DELETED, PUBLISHED];
    const notes = await eventsCommand(["--app", "notes"], workspace(), ENV, reply(200, { events: all }));
    const text = notes!.lines.join("\n");
    expect(text).toContain("notes.note.created.v1");
    expect(text).toContain("notes.note.deleted.v1");
    expect(text).toContain("docs.page.published");

    const search = await eventsCommand(["--app", "search"], workspace(), ENV, reply(200, { events: all }));
    expect(search!.lines.join("\n")).toContain("notes.note.created.v1");
    expect(search!.lines.join("\n")).not.toContain("notes.note.deleted.v1");
    expect(search!.lines.join("\n")).not.toContain("docs.page.published");

    const none = await eventsCommand(["--app", "billing"], workspace(), ENV, reply(200, { events: all }));
    expect(none?.ok).toBe(true);
    expect(none?.lines).toEqual(["billing publishes and subscribes to nothing."]);
  });

  it("says so when the catalog is empty", async () => {
    const r = await eventsCommand([], workspace(), ENV, reply(200, { events: [] }));
    expect(r?.ok).toBe(true);
    expect(r?.lines).toEqual(["core-api lists no event types."]);
  });

  it("--json prints the (filtered, sorted) entries as JSON", async () => {
    const r = await eventsCommand(
      ["--json", "--app", "search"],
      workspace(),
      ENV,
      reply(200, { events: [DELETED, CREATED] }),
    );
    expect(r?.ok).toBe(true);
    expect(r?.stdout).toBe(true);
    expect(JSON.parse(r!.lines.join("\n"))).toEqual({ events: [CREATED] });
    const all = await eventsCommand(["--json"], workspace(), ENV, reply(200, { events: [DELETED, CREATED] }));
    expect(JSON.parse(all!.lines.join("\n"))).toEqual({ events: [CREATED, DELETED] });
  });

  it("replaces control characters in what core-api sends", async () => {
    const evil = {
      ...CREATED,
      type: "x.y\u001b[2J",
      publisher: { appId: "no\u0007tes", version: "1.\u009b0", state: "active" },
      subscribers: [{ ...CREATED.subscribers[0], appId: "se\u001barch" }],
    };
    const r = await eventsCommand([], workspace(), ENV, reply(200, { events: [evil, PUBLISHED] }));
    expect(r?.ok).toBe(true);
    // eslint-disable-next-line no-control-regex
    for (const line of r!.lines) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    const text = r!.lines.join("\n");
    expect(text).toContain("x.y?[2J");
    expect(text).toContain("no?tes@1.?0");
    expect(text).toContain("se?arch");
  });
});

describe("platform events schema", () => {
  it("prints the uploaded schema as JSON text, with who uploaded it and when", async () => {
    const r = await eventsCommand(
      ["schema", "notes.note.created.v1"],
      workspace(),
      ENV,
      reply(200, { events: [CREATED, DELETED] }),
    );
    expect(r?.ok).toBe(true);
    expect(r?.stdout).toBe(true);
    expect(r!.lines[0]).toBe("notes.note.created.v1: uploaded by notes@1.2.0, 2026-10-12 09:30 UTC");
    expect(r!.lines[1]).toBe("");
    expect(JSON.parse(r!.lines.slice(2).join("\n"))).toEqual(SCHEMA);
  });

  it("fails for an unknown type, a type nobody publishes, and one without a schema", () => {
    const all = [CREATED, DELETED, PUBLISHED] as never;
    expect(formatSchema(all, "shop.order.shipped.v1")).toEqual({
      ok: false,
      lines: ['core-api\'s catalog has no event type "shop.order.shipped.v1".'],
    });
    expect(formatSchema(all, "docs.page.published")).toEqual({
      ok: false,
      lines: ["No installed app publishes docs.page.published, so it has no schema."],
    });
    expect(formatSchema(all, "notes.note.deleted.v1")).toEqual({
      ok: false,
      lines: ["notes@1.2.0 publishes notes.note.deleted.v1 but hasn't uploaded a schema."],
    });
  });

  it("fails, instead of throwing, when a provided schema isn't an object", () => {
    for (const schema of [undefined, "x", ["a"]]) {
      const r = formatSchema([{ ...CREATED, schema }] as never, "notes.note.created.v1");
      expect(r).toEqual({
        ok: false,
        lines: ["notes@1.2.0 publishes notes.note.created.v1 but hasn't uploaded a schema."],
      });
    }
  });

  it("replaces C1 control characters JSON.stringify leaves in schema text", () => {
    const evil = { ...CREATED, schema: { description: "a\u009bb\u001bc" } };
    const r = formatSchema([evil] as never, "notes.note.created.v1");
    expect(r.ok).toBe(true);
    // eslint-disable-next-line no-control-regex
    for (const line of r.lines) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(r.lines.join("\n")).toContain('"description": "a?b\\u001bc"');
  });
});

describe("platform events search: arguments", () => {
  it("takes the words as one query, with --app <id> and --json anywhere, at most once each", () => {
    expect(parseEventsArgs(["search", "note", "created"])).toEqual({
      action: "search",
      query: "note created",
      json: false,
    });
    expect(parseEventsArgs(["search", "--app", "notes", "note", "--json", "created"])).toEqual({
      action: "search",
      query: "note created",
      app: "notes",
      json: true,
    });
    expect(parseEventsArgs(["search", "which app emits something when a note is created?"])).toEqual({
      action: "search",
      query: "which app emits something when a note is created?",
      json: false,
    });
  });

  it("needs a word, and refuses unknown flags, a bad app id and repeats", () => {
    expect(parseEventsArgs(["search"])).toBeNull();
    expect(parseEventsArgs(["search", "  "])).toBeNull();
    expect(parseEventsArgs(["search", "--json"])).toBeNull();
    expect(parseEventsArgs(["search", "note", "--limit", "3"])).toBeNull();
    expect(parseEventsArgs(["search", "note", "--app", "Not An Id"])).toBeNull();
    expect(parseEventsArgs(["search", "note", "--json", "--json"])).toBeNull();
    expect(parseEventsArgs(["search", "note", "--app"])).toBeNull();
    // `search` is a subcommand only in first place; elsewhere it's an unknown word, as before.
    expect(parseEventsArgs(["--json", "search", "note"])).toBeNull();
  });

  it("cuts a long query as Admin's search box does", () => {
    const p = parseEventsArgs(["search", "a".repeat(150)]);
    expect(p).toEqual({ action: "search", query: "a".repeat(100), json: false });
  });

  it("prints the usage (null) for a search without words, before any request", async () => {
    const fetchImpl = reply(200, { events: [] });
    expect(await eventsCommand(["search"], workspace(), ENV, fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("platform events search", () => {
  it("prints the hits best first, with score, where they matched and the publisher", async () => {
    const fetchImpl = reply(200, { events: [DELETED, CREATED, PUBLISHED] });
    const r = await eventsCommand(["search", "note", "created"], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(true);
    expect(r?.stdout).toBe(true);
    const text = r!.lines.join("\n");
    expect(r!.lines[0]).toBe('1 event type matches "note created" (searched for: note, creat).');
    expect(text).toMatch(/^Type\s+Score\s+Matched in\s+Publisher$/m);
    expect(text).toMatch(/^notes\.note\.created\.v1\s+8\s+type, app, description, schema property\s+notes@1\.2\.0$/m);
    expect(text).not.toContain("notes.note.deleted");
    expect(text).toContain("pnpm platform events schema <type>");
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://localhost:4020/admin/v1/events");
  });

  it("ranks a type match over an app match, and finds through subscribers and schemas", async () => {
    const fetchImpl = reply(200, { events: [DELETED, CREATED, PUBLISHED] });
    const r = await eventsCommand(["search", "notes"], workspace(), ENV, fetchImpl);
    const rows = r!.lines.filter((l) => /^\S+\.\S+\s+\d+\s/.test(l)).map((l) => l.split(/\s+/)[0]);
    // Every type names "note"; ties keep the type order.
    expect(rows).toEqual(["notes.note.created.v1", "notes.note.deleted.v1", "docs.page.published"]);
    const s = await eventsCommand(["search", "search"], workspace(), ENV, reply(200, { events: [CREATED, DELETED] }));
    expect(s!.lines[0]).toBe('1 event type matches "search" (searched for: search).');
    expect(s!.lines.join("\n")).toMatch(/^notes\.note\.created\.v1\s+2\s+app\s+notes@1\.2\.0$/m);
  });

  it("--app searches only the types the app publishes or subscribes to", async () => {
    const fetchImpl = reply(200, { events: [DELETED, CREATED, PUBLISHED] });
    const r = await eventsCommand(["search", "published", "--app", "search"], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(true);
    expect(r?.lines).toEqual(['No event type matches "published" among search\'s types (searched for: publish).']);
  });

  it("says so, and still exits 0, when nothing matches", async () => {
    const r = await eventsCommand(["search", "invoice"], workspace(), ENV, reply(200, { events: [CREATED] }));
    expect(r).toEqual({
      ok: true,
      stdout: true,
      lines: ['No event type matches "invoice" (searched for: invoice).'],
    });
  });

  it("searches question words only when the query has nothing else", () => {
    expect(formatSearch([CREATED as never], "what is there")[0]).toBe(
      'No event type matches "what is there" (searched for: what, is, there).',
    );
  });

  it("--json prints the query, its words and the hits with their entries", async () => {
    const fetchImpl = reply(200, { events: [DELETED, CREATED, PUBLISHED] });
    const r = await eventsCommand(["search", "page", "--json"], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(true);
    expect(JSON.parse(r!.lines.join("\n"))).toEqual({
      query: "page",
      terms: ["page"],
      hits: [{ score: 4, matched: ["type"], entry: PUBLISHED }],
    });
  });

  it("replaces control characters in what core-api sends and in the query", async () => {
    const evil = {
      ...CREATED,
      type: "notes.note.created\u001b[2J",
      publisher: { ...CREATED.publisher, version: "1\u009b" },
    };
    const r = await eventsCommand(["search", "note\u0007"], workspace(), ENV, reply(200, { events: [evil] }));
    // eslint-disable-next-line no-control-regex
    for (const line of r!.lines) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(r!.lines.join("\n")).toContain("notes.note.created");
  });

  it("refuses as the other events commands do", async () => {
    const u = await eventsCommand(["search", "note"], workspace(), ENV, reply(401, { error: "unauthorized" }));
    expect(u).toEqual({ ok: false, lines: ["core-api didn't accept the admin token (CORE_API_ADMIN_TOKEN)."] });
    const bad = await eventsCommand(["search", "note"], workspace(), ENV, reply(200, { events: "nope" }));
    expect(bad).toEqual({
      ok: false,
      lines: ["core-api's reply to GET /admin/v1/events isn't what this CLI expects."],
    });
  });
});

describe("platform events: refusals", () => {
  it("fails when core-api is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const r = await eventsCommand([], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(false);
    expect(r?.lines).toEqual(["core-api isn't reachable at http://localhost:4020 (is `pnpm dev` running?)."]);
  });

  it("names a rejected token, a missing core.admin and a missing route", async () => {
    const u = await eventsCommand([], workspace(), ENV, reply(401, { error: "unauthorized" }));
    expect(u?.ok).toBe(false);
    expect(u?.lines).toEqual(["core-api didn't accept the admin token (CORE_API_ADMIN_TOKEN)."]);
    const f = await eventsCommand(["schema", "a.b"], workspace(), ENV, reply(403, { error: "forbidden" }));
    expect(f?.ok).toBe(false);
    expect(f?.lines).toEqual(["core-api refused: this sign-in doesn't hold core.admin."]);
    const n = await eventsCommand([], workspace(), ENV, reply(404, { error: "not_found" }));
    expect(n?.lines).toEqual(["core-api has no /admin/v1/events."]);
  });

  it("fails on a reply that isn't a catalog, instead of printing garbage", async () => {
    const bodies = [
      [],
      { events: "nope" },
      { events: [{ type: 1, subscribers: [] }] },
      { events: [{ type: "a.b" }] },
      { events: [{ type: "a.b", subscribers: [null], publisher: null }] },
      { events: [{ type: "a.b", subscribers: [], publisher: "notes" }] },
      { events: [{ type: "a.b", subscribers: [], publisher: null }] },
      { events: [null] },
    ];
    for (const body of bodies) {
      const r = await eventsCommand([], workspace(), ENV, reply(200, body));
      expect(r?.ok).toBe(false);
      expect(r?.lines).toEqual(["core-api's reply to GET /admin/v1/events isn't what this CLI expects."]);
    }
    expect(asCatalog({ events: [] })).toEqual([]);
  });

  it("fails without an admin endpoint, before any request", async () => {
    const fetchImpl = reply(200, { events: [] });
    const r = await eventsCommand([], workspace(), {}, fetchImpl);
    expect(r?.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
