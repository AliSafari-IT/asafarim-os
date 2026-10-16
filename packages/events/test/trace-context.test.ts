/**
 * W3C trace context on events (P6 part 2a): validation, capture at outbox-write time, and the trace
 * id surviving outbox → relay → consumer, against a fake database and a fake JetStream client.
 */
import type { JetStreamClient } from "@nats-io/jetstream";
import { describe, expect, it } from "vitest";
import {
  createDeliveryMemory,
  createEvent,
  createPublisher,
  isTracestate,
  parseTraceparent,
  processDelivery,
  startRelay,
  traceContextOf,
  type CloudEvent,
  type Queryable,
  type RelayClient,
  type RelayLogger,
  type RelayPool,
  type TraceContextSource,
} from "../src/index.ts";

const TYPE = "notes.note.created.v1";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;
const TRACESTATE = "congo=t61rcWkgMzE,rojo=00f067aa0ba902b7";
const quiet: RelayLogger = { info: () => undefined, warn: () => undefined };

const manifest = {
  id: "notes",
  events: { publishes: [{ type: TYPE, schema: "./events/notes.note.created.v1.json" }] },
};
const schemas = {
  "./events/notes.note.created.v1.json": {
    type: "object",
    required: ["id"],
    additionalProperties: false,
    properties: { id: { type: "string" } },
  },
};

/** Traceparents that must be ignored (or refused, when given explicitly). */
const INVALID_TRACEPARENTS: unknown[] = [
  `01-${TRACE_ID}-${SPAN_ID}-01`, // another version
  `ff-${TRACE_ID}-${SPAN_ID}-01`,
  `00-${"0".repeat(32)}-${SPAN_ID}-01`, // all-zero trace id
  `00-${TRACE_ID}-${"0".repeat(16)}-01`, // all-zero span id
  `00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`, // uppercase
  `00-${TRACE_ID.slice(1)}-${SPAN_ID}-01`, // 31 hex
  `00-${TRACE_ID}-${SPAN_ID}-1`, // 1-hex flags
  `00-${TRACE_ID}-${SPAN_ID}-001`, // 3-hex flags
  `00-${TRACE_ID}-${SPAN_ID}-01-extra`,
  ` ${TRACEPARENT}`,
  "",
  42,
  null,
  { traceId: TRACE_ID },
];

/** A transaction stand-in that keeps the outbox rows it is given. */
function outbox() {
  const rows: { seq: string; id: string; type: string; envelope: string; sent: boolean }[] = [];
  const tx: Queryable = {
    query: async (text, values) => {
      if (text.startsWith("INSERT INTO asafarim_outbox")) {
        const [id, type, envelope] = values as [string, string, string];
        rows.push({ seq: String(rows.length + 1), id, type, envelope, sent: false });
      }
      return { rows: [], rowCount: 1 };
    },
  };
  /** The relay's view of the same table: jsonb comes back parsed, like `pg` returns it. */
  const pool: RelayPool = {
    async connect() {
      const client: RelayClient = {
        async query<R>(text: string, values?: unknown[]) {
          if (text.startsWith("SELECT seq, id, type, envelope")) {
            const pending = rows
              .filter((r) => !r.sent)
              .map((r) => ({ seq: r.seq, id: r.id, type: r.type, envelope: JSON.parse(r.envelope) as unknown }));
            return { rows: pending as R[], rowCount: pending.length };
          }
          if (text.startsWith("UPDATE asafarim_outbox") && text.includes("sent_at = now()")) {
            const row = rows.find((r) => r.seq === values![0]);
            if (row) row.sent = true;
          }
          return { rows: [] as R[], rowCount: 0 };
        },
        release: () => undefined,
      };
      return client;
    },
  };
  return { tx, pool, rows };
}

/** A JetStream client stand-in that keeps what it is asked to publish. */
function fakeBus() {
  const sent: { subject: string; data: Uint8Array; msgID: string | undefined }[] = [];
  const client = {
    publish: async (subject: string, data: Uint8Array, o?: { msgID?: string }) => {
      sent.push({ subject, data, msgID: o?.msgID });
      return { stream: "APP_NOTES", seq: sent.length, duplicate: false };
    },
  } as unknown as JetStreamClient;
  return { client, sent };
}

/** The consuming app's database: every inbox insert is new. */
const inboxPool: RelayPool = {
  async connect() {
    return {
      async query<R>(text: string) {
        return { rows: [] as R[], rowCount: text.startsWith("INSERT INTO asafarim_inbox") ? 1 : 0 };
      },
      release: () => undefined,
    };
  },
};

/** Publish one event, relay it, consume it; return the outbox row, the bytes on the bus and what the handler saw. */
async function roundTrip(traceContext?: TraceContextSource) {
  const db = outbox();
  const bus = fakeBus();
  const publisher = createPublisher({ manifest, schemas, traceContext });
  const published = await publisher.publish(db.tx, TYPE, { id: "1" }, { subject: "1" });

  const relay = startRelay({
    appId: "notes",
    pool: db.pool,
    jetstream: async () => bus.client,
    autoStart: false,
    log: quiet,
  });
  expect(await relay.drain()).toBe(1);
  await relay.stop();

  const seen: CloudEvent[] = [];
  const outcome = await processDelivery(
    {
      appId: "rec",
      type: TYPE,
      handler: async (event) => void seen.push(event),
      pool: inboxPool,
      memory: createDeliveryMemory(),
      deadLetter: async () => undefined,
    },
    {
      data: bus.sent[0]!.data,
      deliveryCount: 1,
      stream: "APP_NOTES",
      streamSeq: 1,
      ack: async () => undefined,
      nak: () => undefined,
      term: () => undefined,
    },
  );
  expect(outcome).toBe("processed");
  return { published, row: db.rows[0]!, wire: new TextDecoder().decode(bus.sent[0]!.data), consumed: seen[0]! };
}

describe("traceparent and tracestate validation", () => {
  it("parses a valid version-00 traceparent", () => {
    expect(parseTraceparent(TRACEPARENT)).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 });
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-00`)?.traceFlags).toBe(0);
  });

  it("ignores every invalid traceparent (and the tracestate next to it)", () => {
    for (const traceparent of INVALID_TRACEPARENTS) {
      expect(parseTraceparent(traceparent), String(traceparent)).toBeUndefined();
      expect(traceContextOf({ traceparent, tracestate: TRACESTATE }), String(traceparent)).toBeUndefined();
    }
    expect(traceContextOf(undefined)).toBeUndefined();
    expect(traceContextOf({ tracestate: TRACESTATE })).toBeUndefined();
  });

  it("keeps a valid tracestate and drops an invalid one, keeping the traceparent", () => {
    expect(traceContextOf({ traceparent: TRACEPARENT, tracestate: TRACESTATE })).toEqual({
      traceparent: TRACEPARENT,
      tracestate: TRACESTATE,
    });
    expect(isTracestate("vendor=abc, tenant@vendor=x y ,")).toBe(true);
    for (const bad of ["", "=x", "Vendor=x", "a=b=c", "a=x,a=y", "a=", "a b=x", "a=é", "a".repeat(513), 1]) {
      expect(isTracestate(bad), String(bad)).toBe(false);
      expect(traceContextOf({ traceparent: TRACEPARENT, tracestate: bad })).toEqual({ traceparent: TRACEPARENT });
    }
    expect(isTracestate(Array.from({ length: 33 }, (_, i) => `k${i}=v`).join(","))).toBe(false);
  });

  it("createEvent puts tracestate after traceparent, and refuses one without a traceparent or malformed", () => {
    const e = createEvent({ source: "notes", type: TYPE, data: {}, traceparent: TRACEPARENT, tracestate: TRACESTATE });
    expect(Object.keys(e).slice(-2)).toEqual(["traceparent", "tracestate"]);
    expect(() => createEvent({ source: "notes", type: TYPE, data: {}, tracestate: TRACESTATE })).toThrow(
      /needs a traceparent/,
    );
    expect(() =>
      createEvent({ source: "notes", type: TYPE, data: {}, traceparent: TRACEPARENT, tracestate: "Bad" }),
    ).toThrow(/tracestate/);
  });
});

describe("publish: the trace context is captured at outbox-write time", () => {
  it("writes the source's traceparent and tracestate into the outbox row", async () => {
    const db = outbox();
    const p = createPublisher({
      manifest,
      schemas,
      traceContext: () => ({ traceparent: TRACEPARENT, tracestate: TRACESTATE }),
    });
    const e = await p.publish(db.tx, TYPE, { id: "1" });
    expect(e).toMatchObject({ traceparent: TRACEPARENT, tracestate: TRACESTATE });
    expect(JSON.parse(db.rows[0]!.envelope)).toMatchObject({ traceparent: TRACEPARENT, tracestate: TRACESTATE });
  });

  it("adds nothing when there is no span (or no source): the envelope is the one without tracing", async () => {
    const now = () => new Date("2026-10-16T12:00:00.000Z");
    for (const traceContext of [undefined, () => undefined, () => ({})]) {
      const db = outbox();
      const e = await createPublisher({ manifest, schemas, traceContext, now }).publish(db.tx, TYPE, { id: "1" });
      expect(Object.keys(e)).toEqual(["specversion", "id", "source", "type", "time", "datacontenttype", "data"]);
      expect(db.rows[0]!.envelope).toBe(
        JSON.stringify(createEvent({ source: "notes", type: TYPE, data: { id: "1" }, id: e.id, now: now() })),
      );
    }
  });

  it("ignores an invalid captured traceparent, and a source that throws, instead of failing the publish", async () => {
    for (const traceparent of INVALID_TRACEPARENTS) {
      const db = outbox();
      const e = await createPublisher({ manifest, schemas, traceContext: () => ({ traceparent }) }).publish(
        db.tx,
        TYPE,
        { id: "1" },
      );
      expect(e).not.toHaveProperty("traceparent");
      expect(db.rows[0]!.envelope).not.toMatch(/trace/);
    }
    const throwing = createPublisher({
      manifest,
      schemas,
      traceContext: () => {
        throw new Error("no tracer");
      },
    });
    await expect(throwing.publish(outbox().tx, TYPE, { id: "1" })).resolves.not.toHaveProperty("traceparent");
  });

  it("an explicit traceparent wins over the source; a malformed explicit one still throws", async () => {
    const other = `00-${"a".repeat(32)}-${"b".repeat(16)}-00`;
    const p = createPublisher({
      manifest,
      schemas,
      traceContext: () => ({ traceparent: TRACEPARENT, tracestate: TRACESTATE }),
    });
    const e = await p.publish(outbox().tx, TYPE, { id: "1" }, { traceparent: other });
    expect(e.traceparent).toBe(other);
    expect(e).not.toHaveProperty("tracestate");
    await expect(p.publish(outbox().tx, TYPE, { id: "1" }, { traceparent: "00-0-0-01" })).rejects.toThrow(
      /traceparent/,
    );
  });
});

describe("outbox → relay → consumer", () => {
  it("keeps the trace id (and tracestate) from the publishing request to the handler", async () => {
    const { published, row, wire, consumed } = await roundTrip(() => ({
      traceparent: TRACEPARENT,
      tracestate: TRACESTATE,
    }));
    expect(JSON.parse(row.envelope)).toMatchObject({ traceparent: TRACEPARENT });
    expect(JSON.parse(wire)).toEqual(published);
    expect(consumed).toEqual(published);
    expect(parseTraceparent(traceContextOf(consumed)?.traceparent)).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: 1,
    });
    expect(traceContextOf(consumed)?.tracestate).toBe(TRACESTATE);
  });

  it("without a trace context the bytes on the bus have no tracing attributes", async () => {
    const { published, wire, consumed } = await roundTrip(() => undefined);
    expect(wire).toBe(JSON.stringify(published));
    expect(wire).not.toMatch(/trace/);
    expect(traceContextOf(consumed)).toBeUndefined();
  });
});
