/**
 * `docs.note.created.v1` (Flow, ADR 0001): the store writes it to the outbox in the note's own
 * transaction, on every create and on an edit that adds the tag `issue`; never on delete, and it
 * never carries the note's body or its quote. The store is the real one over the transactional
 * stand-in for Postgres (test/fake-db.ts).
 */
import { compileEventSchema, EventValidationError } from "@asafarim/app-sdk/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../events/docs.note.created.v1.json";
import { NOTE_CREATED, publisher } from "../lib/events";
import { createNotesStore, type NotesStore } from "../lib/notes";
import { fakeDb, type FakeDb } from "./fake-db";

const BODY = "Ask **Team B** about the beta. A private thought.";
const QUOTE = "Ship the beta in the second quarter";
const input = {
  docPath: "ventures/demo-app/roadmap/roadmap.md",
  headingId: "milestones",
  quote: QUOTE,
  body: BODY,
  docSha: "a".repeat(64),
};

let db: FakeDb;
let store: NotesStore;
let onCommit: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  db = fakeDb();
  onCommit = vi.fn<() => void>();
  store = createNotesStore(db.pool, { onCommit });
});

const events = () => db.outbox.map((r) => r.envelope);

describe("creating a note publishes docs.note.created.v1", () => {
  it("once, with the note's id, author, document, tags, issue state and creation time", async () => {
    const note = await store.create("owner", { ...input, body: `${BODY} #Issue #todo #issue` });
    expect(db.outbox).toHaveLength(1);
    const [row] = db.outbox;
    expect(row).toMatchObject({ type: NOTE_CREATED, envelope: { type: NOTE_CREATED, subject: note.id } });
    expect(row!.envelope.data).toEqual({
      id: note.id,
      author: "owner",
      docPath: input.docPath,
      tags: ["issue", "todo"],
      hasIssue: false,
      createdAt: note.createdAt,
    });
    // The relay is woken once the transaction committed.
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("in the same transaction as the insert", async () => {
    await store.create("owner", input);
    const sqls = db.statements.map((s) => s.sql).filter((s) => !s.includes("CREATE TABLE"));
    expect(sqls).toEqual([
      "BEGIN",
      expect.stringMatching(/^INSERT INTO notes/),
      expect.stringMatching(/^INSERT INTO asafarim_outbox/),
      "COMMIT",
    ]);
  });

  it("a failed note insert leaves no outbox row (and no note)", async () => {
    db.failOn = (sql) => sql.startsWith("INSERT INTO notes");
    await expect(store.create("owner", input)).rejects.toThrow("connection lost");
    expect(db.notes).toEqual([]);
    expect(db.outbox).toEqual([]);
    expect(db.statements.at(-1)?.sql).toBe("ROLLBACK");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("a failed outbox write leaves no note: both happen, or neither", async () => {
    db.failOn = (sql) => sql.startsWith("INSERT INTO asafarim_outbox");
    await expect(store.create("owner", input)).rejects.toThrow("connection lost");
    expect(db.notes).toEqual([]);
    expect(db.outbox).toEqual([]);
  });

  it("a failed commit leaves neither", async () => {
    db.failOn = (sql) => sql === "COMMIT";
    await expect(store.create("owner", input)).rejects.toThrow("connection lost");
    expect(db.notes).toEqual([]);
    expect(db.outbox).toEqual([]);
  });
});

describe("editing a note", () => {
  it("publishes when the edit adds #issue: same type, same fields, the creation time unchanged", async () => {
    const note = await store.create("owner", { ...input, body: "First thoughts #todo" });
    await new Promise((r) => setTimeout(r, 5));
    const edited = await store.update("owner", note.id, "First thoughts #todo, now an #issue");
    expect(edited?.updatedAt).not.toBe(note.createdAt);
    expect(events()).toHaveLength(2);
    expect(events()[1]).toMatchObject({ type: NOTE_CREATED, subject: note.id });
    expect(events()[1]!.data).toEqual({
      id: note.id,
      author: "owner",
      docPath: input.docPath,
      tags: ["todo", "issue"],
      hasIssue: false,
      createdAt: note.createdAt,
    });
  });

  it("publishes in the edit's transaction, after reading the note's tags before it (row locked)", async () => {
    const note = await store.create("owner", input);
    db.statements.length = 0;
    await store.update("owner", note.id, `${BODY} #issue`);
    expect(db.statements.map((s) => s.sql)).toEqual([
      "BEGIN",
      expect.stringMatching(/^SELECT body FROM notes .* FOR UPDATE$/),
      expect.stringMatching(/^UPDATE notes/),
      expect.stringMatching(/^INSERT INTO asafarim_outbox/),
      "COMMIT",
    ]);
  });

  it("says hasIssue when the note already has an issue URL", async () => {
    const note = await store.create("owner", input);
    await store.setIssueUrl("owner", note.id, "https://github.com/example-org/handbook/issues/7");
    await store.update("owner", note.id, `${BODY} #issue`);
    expect(events().map((e) => e.data.hasIssue)).toEqual([false, true]);
  });

  it.each([
    ["the note already had #issue", "Before #issue", "After #issue, edited"],
    ["the edit doesn't add it", "Before #todo", "After #todo #later"],
    ["the edit removes it", "Before #issue", "After, no tag"],
    ["#issue is only in code", "Before", "After `#issue`\n```\n#issue\n```"],
    ["it's only part of a URL", "Before", "After https://example.test/#issue"],
    ["it already had it in another case", "Before #ISSUE", "After #issue"],
  ])("doesn't publish when %s", async (_what, before, after) => {
    const note = await store.create("owner", { ...input, body: before });
    await store.update("owner", note.id, after);
    expect(db.outbox).toHaveLength(1);
    expect(db.notes[0]?.body).toBe(after);
  });

  it("re-adding #issue after removing it publishes again (it wasn't there before that edit)", async () => {
    const note = await store.create("owner", { ...input, body: "One #issue" });
    await store.update("owner", note.id, "Two");
    await store.update("owner", note.id, "Three #issue");
    expect(db.outbox).toHaveLength(2);
  });

  it("someone else's note: nothing changes, nothing is published", async () => {
    const note = await store.create("owner", input);
    expect(await store.update("someone-else", note.id, "Mine #issue")).toBeNull();
    expect(db.outbox).toHaveLength(1);
    expect(db.notes[0]?.body).toBe(BODY);
  });

  it("a failed outbox write rolls the edit back", async () => {
    const note = await store.create("owner", input);
    db.failOn = (sql) => sql.startsWith("INSERT INTO asafarim_outbox");
    await expect(store.update("owner", note.id, "Now an #issue")).rejects.toThrow("connection lost");
    expect(db.notes[0]?.body).toBe(BODY);
    expect(db.outbox).toHaveLength(1);
  });
});

describe("deleting a note", () => {
  it("publishes nothing", async () => {
    const note = await store.create("owner", { ...input, body: "#issue" });
    expect(await store.remove("owner", note.id)).toBe(true);
    expect(db.outbox).toHaveLength(1);
  });
});

describe("the payload", () => {
  it("validates against events/docs.note.created.v1.json", async () => {
    const validate = compileEventSchema(schema);
    const note = await store.create("owner", { ...input, body: `${BODY} #issue` });
    await store.update("owner", note.id, `${BODY} #todo`);
    await store.update("owner", note.id, `${BODY} #issue again`);
    expect(events()).toHaveLength(2);
    for (const e of events()) expect(validate(e.data), JSON.stringify(validate.errors)).toBe(true);
  });

  it("never contains the note's body or its quote", async () => {
    const note = await store.create("owner", { ...input, body: `${BODY} #issue` });
    await store.update("owner", note.id, `${BODY} edited`);
    await store.update("owner", note.id, `${BODY} edited #issue`);
    for (const row of db.outbox) {
      const json = JSON.stringify(row.envelope);
      expect(json).not.toContain("Team B");
      expect(json).not.toContain("private thought");
      expect(json).not.toContain(QUOTE);
      expect(Object.keys(row.envelope.data).sort()).toEqual(
        ["author", "createdAt", "docPath", "hasIssue", "id", "tags"].sort(),
      );
    }
  });

  it("the schema refuses a body, a quote, or a tag that isn't one", () => {
    const ok = {
      id: "1",
      author: "owner",
      docPath: input.docPath,
      tags: ["issue"],
      hasIssue: false,
      createdAt: "2026-10-26T12:00:00.000Z",
    };
    expect(() => publisher.validate(NOTE_CREATED, ok)).not.toThrow();
    for (const bad of [
      { ...ok, body: BODY },
      { ...ok, quote: QUOTE },
      { ...ok, tags: ["Issue"] },
      { ...ok, tags: ["issue", "issue"] },
      { ...ok, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) },
      { ...ok, tags: ["a".repeat(41)] },
      { ...ok, id: 1 },
      { ...ok, hasIssue: "no" },
      { ...ok, createdAt: "yesterday" },
    ]) {
      expect(() => publisher.validate(NOTE_CREATED, bad)).toThrow(EventValidationError);
    }
    const { tags: _tags, ...missing } = ok;
    expect(() => publisher.validate(NOTE_CREATED, missing)).toThrow(EventValidationError);
  });
});
