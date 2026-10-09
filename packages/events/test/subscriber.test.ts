/**
 * Unit tests for subscribing (P4.1): consumer naming, and the inbox/handler transaction wrapper
 * (`processDelivery`) against a fake database and a fake delivery. The real bus and Postgres are in
 * consumer.integration.test.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INBOX_SQL,
  consumerName,
  createDeliveryMemory,
  createEvent,
  deadLetterSubject,
  parseEnvelope,
  processDelivery,
  publisherOf,
  subscribe,
  type DeadLetter,
  type Delivery,
  type EventHandler,
  type RelayClient,
  type RelayPool,
} from "../src/index.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const TYPE = "notes.note.created.v1";
const encode = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));

describe("consumer naming", () => {
  it("is <consumer-app>.<type> with every '.' turned into '_' (a valid NATS consumer name)", () => {
    expect(consumerName("note-recorder", TYPE)).toBe("note-recorder_notes_note_created_v1");
    expect(consumerName("tasksai", "testora.run.completed.v12")).toBe("tasksai_testora_run_completed_v12");
    expect(consumerName("a1", TYPE)).not.toMatch(/[.*>\s/\\]/);
  });

  it("never maps two (app, type) pairs to the same name", () => {
    const pairs: [string, string][] = [
      ["ab", "cd.ef.gh.v1"],
      ["ab-cd", "ef.gh.ij.v1"],
      ["abcd", "ef.gh.ij.v1"],
      ["ab", "cd-ef.gh.ij.v1"],
    ];
    const names = pairs.map(([a, t]) => consumerName(a, t));
    expect(new Set(names).size).toBe(names.length);
  });

  it("refuses an invalid app id or event type", () => {
    expect(() => consumerName("Notes", TYPE)).toThrow(/app id/);
    expect(() => consumerName("x", TYPE)).toThrow(/app id/);
    expect(() => consumerName("notes", "notes.created")).toThrow(/<app>\.<entity>/);
    expect(() => consumerName("notes", "notes.note.*.v1")).toThrow();
  });

  it("the publisher is the type's namespace; dead letters go to deadletter.<consumer-app>.<type>", () => {
    expect(publisherOf(TYPE)).toBe("notes");
    expect(deadLetterSubject("note-recorder", TYPE)).toBe(`deadletter.note-recorder.${TYPE}`);
  });

  it("subscribe refuses a bad type or a missing bus before connecting", () => {
    const pool = { connect: async () => ({}) as RelayClient };
    expect(() => subscribe("nope", async () => undefined, { appId: "rec", pool, servers: "nats://x" })).toThrow();
    expect(() => subscribe(TYPE, async () => undefined, { appId: "rec", pool })).toThrow(/servers/);
  });
});

describe("parseEnvelope", () => {
  const event = createEvent({ source: "notes", type: TYPE, data: { id: "1" } });
  it("accepts the publisher's CloudEvent of the subscribed type", () => {
    expect(parseEnvelope(encode(event), TYPE)).toEqual(event);
  });
  it("refuses non-JSON, another type, another source, no id", () => {
    expect(() => parseEnvelope(encode("{"), TYPE)).toThrow(/JSON/);
    expect(() => parseEnvelope(encode({ ...event, type: "notes.note.deleted.v1" }), TYPE)).toThrow(/type/);
    expect(() => parseEnvelope(encode({ ...event, source: "asafarim://evil" }), TYPE)).toThrow(/source/);
    expect(() => parseEnvelope(encode({ ...event, id: "" }), TYPE)).toThrow(/id/);
    expect(() => parseEnvelope(encode({ ...event, specversion: "0.3" }), TYPE)).toThrow(/specversion/);
  });
});

/** A fake database: records statements, keeps inbox rows across committed transactions only. */
function fakeDb() {
  const inbox = new Set<string>();
  const log: string[] = [];
  let released = 0;
  /** Failures to inject: how many of the next connects / BEGINs / inbox INSERTs throw, and a COMMIT error. */
  const faults = { connect: 0, begin: 0, insert: 0, commit: undefined as Error | undefined };
  const pool: RelayPool = {
    async connect() {
      if (faults.connect > 0) {
        faults.connect--;
        throw new Error("connect ECONNREFUSED");
      }
      let pendingInbox: string | undefined;
      const client: RelayClient = {
        async query<R>(text: string, values?: unknown[]) {
          const sql = text.trim().split(/\s+/).slice(0, 3).join(" ");
          log.push(sql);
          if (text === "BEGIN" && faults.begin > 0) {
            faults.begin--;
            throw new Error("the database system is starting up");
          }
          if (text === "COMMIT" && faults.commit) {
            const err = faults.commit;
            faults.commit = undefined;
            pendingInbox = undefined;
            throw err;
          }
          if (text.startsWith("INSERT INTO asafarim_inbox") && faults.insert > 0) {
            faults.insert--;
            throw new Error("Connection terminated unexpectedly");
          }
          if (text.startsWith("INSERT INTO asafarim_inbox")) {
            const id = values![0] as string;
            if (inbox.has(id)) return { rows: [] as R[], rowCount: 0 };
            pendingInbox = id;
            return { rows: [] as R[], rowCount: 1 };
          }
          if (text === "COMMIT" && pendingInbox) inbox.add(pendingInbox);
          if (text === "COMMIT" || text === "ROLLBACK") pendingInbox = undefined;
          return { rows: [] as R[], rowCount: 0 };
        },
        release: () => void released++,
      };
      return client;
    },
  };
  return { pool, inbox, log, faults, released: () => released };
}

function fakeDelivery(data: Uint8Array, deliveryCount = 1) {
  const calls: string[] = [];
  const d: Delivery = {
    data,
    deliveryCount,
    stream: "APP_NOTES",
    streamSeq: 42,
    ack: async () => void calls.push("ack"),
    nak: (ms) => void calls.push(`nak:${ms}`),
    term: (reason) => void calls.push(`term:${reason}`),
  };
  return { d, calls };
}

describe("processDelivery: the inbox and the handler in one transaction", () => {
  const event = createEvent({ source: "notes", type: TYPE, data: { id: "7" } });
  const now = () => new Date("2026-10-09T12:00:00Z");

  function setup(handler: EventHandler, extra: { maxDeliver?: number; deadLetterFails?: boolean } = {}) {
    const db = fakeDb();
    const letters: { subject: string; letter: DeadLetter; msgId: string }[] = [];
    const bus = { deadLetterFails: extra.deadLetterFails ?? false };
    const opts = {
      appId: "rec",
      type: TYPE,
      handler,
      pool: db.pool,
      memory: createDeliveryMemory(),
      maxDeliver: extra.maxDeliver,
      backoff: { initialMs: 100, maxMs: 1000 },
      now,
      deadLetter: async (subject: string, letter: DeadLetter, msgId: string) => {
        if (bus.deadLetterFails) throw new Error("bus down");
        letters.push({ subject, letter, msgId });
      },
    };
    return { db, letters, opts, bus };
  }

  /** Deliver the same stream message `n` times (delivery counts from..from+n-1); return the outcomes. */
  async function deliver(opts: Parameters<typeof processDelivery>[0], n: number, from = 1) {
    const out: { outcome: string; calls: string[] }[] = [];
    for (let i = 0; i < n; i++) {
      const { d, calls } = fakeDelivery(encode(event), from + i);
      out.push({ outcome: await processDelivery(opts, d), calls });
    }
    return out;
  }

  it("runs the handler inside BEGIN … COMMIT after the inbox insert, and acks only after the commit", async () => {
    const seen: unknown[] = [];
    const { db, opts } = setup(async (e, tx) => {
      seen.push(e);
      await tx.query("UPDATE things SET n = n + 1");
    });
    const { d, calls } = fakeDelivery(encode(event));
    expect(await processDelivery(opts, d)).toBe("processed");
    expect(seen).toEqual([event]);
    expect(db.log).toEqual(["BEGIN", "INSERT INTO asafarim_inbox", "UPDATE things SET", "COMMIT"]);
    expect(calls).toEqual(["ack"]);
    expect([...db.inbox]).toEqual([event.id]);
    expect(db.released()).toBe(1);
  });

  it("a duplicate event id: no handler call, rolled back, acked", async () => {
    let n = 0;
    const { db, opts } = setup(async () => void n++);
    await processDelivery(opts, fakeDelivery(encode(event)).d);
    const { d, calls } = fakeDelivery(encode(event), 2);
    expect(await processDelivery(opts, d)).toBe("duplicate");
    expect(n).toBe(1);
    expect(calls).toEqual(["ack"]);
    expect(db.log.slice(-3)).toEqual(["BEGIN", "INSERT INTO asafarim_inbox", "ROLLBACK"]);
    expect(db.inbox.size).toBe(1);
  });

  it("a handler error: rolled back (no inbox row), not acked, nak with the backoff delay", async () => {
    const { db, opts } = setup(async () => {
      throw new Error("boom");
    });
    const { d, calls } = fakeDelivery(encode(event), 2);
    expect(await processDelivery(opts, d)).toBe("retry");
    expect(db.log.at(-1)).toBe("ROLLBACK");
    expect(db.inbox.size).toBe(0);
    expect(calls).toEqual(["nak:100"]); // the 1st handler failure: 100 × 2^0, whatever the delivery count
    expect(db.released()).toBe(1);
  });

  it("the maxDeliver-th handler failure: the envelope and failure metadata go to deadletter.<app>.<type>, then term", async () => {
    const { letters, opts } = setup(
      async () => {
        throw new Error("still broken");
      },
      { maxDeliver: 3 },
    );
    const out = await deliver(opts, 3);
    expect(out.map((r) => r.outcome)).toEqual(["retry", "retry", "dead_lettered"]);
    expect(out.map((r) => r.calls)).toEqual([["nak:100"], ["nak:200"], ["term:dead-lettered: max_deliver"]]);
    expect(letters).toEqual([
      {
        subject: `deadletter.rec.${TYPE}`,
        msgId: "rec_notes_note_created_v1:APP_NOTES:42",
        letter: {
          envelope: event,
          failure: {
            consumer: "rec",
            type: TYPE,
            reason: "max_deliver",
            attempts: 3,
            deliveries: 3,
            error: "still broken",
            stream: "APP_NOTES",
            streamSeq: 42,
            deadLetteredAt: "2026-10-09T12:00:00.000Z",
          },
        },
      },
    ]);
    expect(JSON.stringify(letters)).not.toMatch(/at .*subscriber/); // no stack trace
  });

  it("the dead letter can't be stored: nak (redelivered); the next delivery dead-letters without running the handler", async () => {
    let n = 0;
    const { opts, letters, bus } = setup(
      async () => {
        n++;
        throw new Error("x");
      },
      { maxDeliver: 2, deadLetterFails: true },
    );
    const failed = await deliver(opts, 2);
    expect(failed.map((r) => r.outcome)).toEqual(["retry", "retry"]); // the 2nd: the dead letter's publish failed
    expect(failed[1]!.calls).toEqual(["nak:200"]);
    expect(n).toBe(2);
    expect(letters).toEqual([]);

    bus.deadLetterFails = false;
    const [third] = await deliver(opts, 1, 3);
    expect(third!.outcome).toBe("dead_lettered");
    expect(n).toBe(2); // the handler didn't run again
    expect(letters[0]!.letter.failure).toMatchObject({ attempts: 2, deliveries: 3, error: "x" });
  });

  it("pool.connect() fails: nak with a backoff, the handler isn't run, nothing counts, never a dead letter", async () => {
    let n = 0;
    const { db, opts, letters } = setup(async () => void n++, { maxDeliver: 2 });
    db.faults.connect = 50;
    const out = await deliver(opts, 50);
    expect(new Set(out.map((r) => r.outcome))).toEqual(new Set(["retry"]));
    expect(out[0]!.calls).toEqual(["nak:100"]);
    expect(out[49]!.calls).toEqual(["nak:1000"]); // capped
    expect(n).toBe(0);
    expect(letters).toEqual([]);
    expect(opts.memory.handlerFailures.size).toBe(0);

    // The database is back: delivery 51 runs the handler and is processed.
    const [back] = await deliver(opts, 1, 51);
    expect(back!.outcome).toBe("processed");
    expect(back!.calls).toEqual(["ack"]);
    expect(n).toBe(1);
  });

  it("BEGIN or the inbox INSERT fails maxDeliver+1 times: no dead letter, and the handler runs once the database is back", async () => {
    let n = 0;
    const { db, opts, letters } = setup(async () => void n++, { maxDeliver: 3 });
    db.faults.begin = 2;
    db.faults.insert = 2;
    const out = await deliver(opts, 4);
    expect(out.map((r) => r.outcome)).toEqual(["retry", "retry", "retry", "retry"]);
    expect(out.every((r) => r.calls.length === 1 && r.calls[0]!.startsWith("nak:"))).toBe(true);
    expect(n).toBe(0);
    expect(letters).toEqual([]);
    expect(db.released()).toBe(4); // every connection went back to the pool
    expect(db.inbox.size).toBe(0);

    const [back] = await deliver(opts, 1, 5);
    expect(back!.outcome).toBe("processed");
    expect(n).toBe(1);
    expect([...db.inbox]).toEqual([event.id]);
  });

  it("delivery maxDeliver+1 after a database outage, with a handler that succeeds: processed", async () => {
    let n = 0;
    const { opts, letters } = setup(async () => void n++, { maxDeliver: 5 });
    const { d, calls } = fakeDelivery(encode(event), 6); // the bus redelivered it during the outage
    expect(await processDelivery(opts, d)).toBe("processed");
    expect(calls).toEqual(["ack"]);
    expect(n).toBe(1);
    expect(letters).toEqual([]);
  });

  it("only handler failures count: interleaved database failures don't move the event toward a dead letter", async () => {
    let n = 0;
    const { db, opts, letters } = setup(
      async () => {
        n++;
        throw new Error("handler bug");
      },
      { maxDeliver: 2 },
    );
    expect((await deliver(opts, 1, 1))[0]!.outcome).toBe("retry"); // handler failure 1
    db.faults.connect = 3;
    expect((await deliver(opts, 3, 2)).map((r) => r.outcome)).toEqual(["retry", "retry", "retry"]);
    expect(letters).toEqual([]);
    expect((await deliver(opts, 1, 5))[0]!.outcome).toBe("dead_lettered"); // handler failure 2
    expect(n).toBe(2);
    expect(letters[0]!.letter.failure).toMatchObject({ attempts: 2, deliveries: 5 });
  });

  it("a COMMIT that loses the connection is retried without counting; a deferred constraint violation counts", async () => {
    let n = 0;
    const { db, opts, letters } = setup(async () => void n++, { maxDeliver: 1 });
    db.faults.commit = new Error("Connection terminated unexpectedly");
    expect((await deliver(opts, 1))[0]!.outcome).toBe("retry");
    expect(letters).toEqual([]);

    db.faults.commit = Object.assign(new Error("violates foreign key constraint"), { code: "23503" });
    expect((await deliver(opts, 1, 2))[0]!.outcome).toBe("dead_lettered");
    expect(letters[0]!.letter.failure).toMatchObject({ attempts: 1, error: "violates foreign key constraint" });
    expect(n).toBe(2);
    expect(db.inbox.size).toBe(0);
  });

  it("after a restart (a new memory) the handler-failure count starts again from zero", async () => {
    const { opts, letters } = setup(
      async () => {
        throw new Error("x");
      },
      { maxDeliver: 2 },
    );
    await deliver(opts, 1);
    const restarted = { ...opts, memory: createDeliveryMemory() };
    expect((await deliver(restarted, 1, 2))[0]!.outcome).toBe("retry");
    expect(letters).toEqual([]);
    expect((await deliver(restarted, 1, 3))[0]!.outcome).toBe("dead_lettered");
  });

  it("a finished message is forgotten", async () => {
    let fail = true;
    const { opts } = setup(async () => {
      if (fail) throw new Error("x");
    });
    await deliver(opts, 1);
    expect(opts.memory.handlerFailures.size).toBe(1);
    fail = false;
    expect((await deliver(opts, 1, 2))[0]!.outcome).toBe("processed");
    expect(opts.memory.handlerFailures.size).toBe(0);
  });

  it("an invalid envelope is dead-lettered at once (retrying can't help), with the raw text", async () => {
    let n = 0;
    const { letters, opts, db } = setup(async () => void n++);
    const { d, calls } = fakeDelivery(encode("not json"));
    expect(await processDelivery(opts, d)).toBe("dead_lettered");
    expect(n).toBe(0);
    expect(db.log).toEqual([]);
    expect(calls).toEqual(["term:dead-lettered: invalid_envelope"]);
    expect(letters[0]!.letter.envelope).toBe("not json");
    expect(letters[0]!.letter.failure.reason).toBe("invalid_envelope");
  });

  it("long error messages are truncated", async () => {
    const { letters, opts } = setup(
      async () => {
        throw new Error("e".repeat(2000));
      },
      { maxDeliver: 1 },
    );
    await processDelivery(opts, fakeDelivery(encode(event), 1).d);
    expect(letters[0]!.letter.failure.error).toHaveLength(500);
  });
});

describe("the inbox migrations", () => {
  it("the plain-SQL and Drizzle files carry the same DDL as INBOX_SQL", () => {
    const strip = (s: string) =>
      s
        .split("\n")
        .filter((l) => !l.startsWith("--"))
        .join("\n")
        .trim();
    expect(strip(readFileSync(path.join(ROOT, "sql/002_inbox.sql"), "utf8"))).toBe(INBOX_SQL.trim());
    expect(strip(readFileSync(path.join(ROOT, "drizzle/0001_asafarim_inbox.sql"), "utf8"))).toBe(INBOX_SQL.trim());
  });
});
