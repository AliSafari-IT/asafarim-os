/**
 * P4.1 acceptance, against a REAL Postgres and a REAL NATS JetStream (the dev stack, `pnpm dev`):
 *
 *  1. creating a note puts exactly one `notes.note.created.v1` on APP_NOTES, with the right
 *     envelope and payload (read back with a test-only ordered consumer);
 *  2. bus down: with NATS stopped, three notes are still created (their events wait in the
 *     outbox); once NATS is back, all three are delivered, once each.
 *
 * `createNote` is the function the API route and the server action call. The stream is created the
 * way core-api's install creates it (`createStreamAdmin().ensureAppStream`).
 *
 * Needs EVENTS_TEST_ADMIN_URL (a superuser URL on a DEV Postgres) and EVENTS_TEST_NATS_URL. The
 * bus-down test also needs EVENTS_TEST_NATS_CONTROL=compose: it then stops and starts the dev
 * stack's NATS container (`docker compose -f compose.dev.yml stop|start nats`, fixed arguments, no shell).
 * Skipped without them, except when EVENTS_TEST_REQUIRED is set (CI), where it fails instead.
 * It uses a throwaway database (dropped afterwards); the APP_NOTES stream is the dev one, so it
 * only reads messages published after it started.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createStreamAdmin, streamName, type CloudEvent, type StreamAdmin } from "@asafarim/app-sdk/events";
import { jetstream, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Types only: lib/db is imported dynamically, after DATABASE_URL points at the throwaway database.
import type * as NotesDb from "../lib/db";

const ADMIN_URL = process.env.EVENTS_TEST_ADMIN_URL;
const NATS_URL = process.env.EVENTS_TEST_NATS_URL;
/** The bus-down test controls the dev stack's NATS container; nothing else is accepted. */
const CONTROL_NATS = process.env.EVENTS_TEST_NATS_CONTROL === "compose";
const COMPOSE_FILE = path.resolve(import.meta.dirname, "../../../compose.dev.yml");
const natsContainer = (action: "stop" | "start") =>
  execFileSync("docker", ["compose", "-f", COMPOSE_FILE, action, "nats"], { stdio: "inherit" });
if (process.env.EVENTS_TEST_REQUIRED && (!ADMIN_URL || !NATS_URL || !CONTROL_NATS)) {
  throw new Error("EVENTS_TEST_ADMIN_URL and EVENTS_TEST_NATS_URL must be set, and EVENTS_TEST_NATS_CONTROL=compose");
}

const STREAM = streamName("notes");
const TYPE = "notes.note.created.v1";
const dbName = `notes_events_test_${Date.now().toString(36)}`;

type Db = typeof NotesDb;

describe.skipIf(!ADMIN_URL || !NATS_URL)(
  "notes publishes notes.note.created.v1 (integration: Postgres + JetStream)",
  () => {
    let admin: pg.Client;
    let nc: NatsConnection;
    let jsm: JetStreamManager;
    let streams: StreamAdmin;
    let notes: Db;
    let appPool: pg.Pool;

    const lastSeq = async () => (await jsm.streams.info(STREAM)).state.last_seq;
    const pending = async () =>
      Number((await appPool.query("SELECT count(*) AS n FROM asafarim_outbox WHERE sent_at IS NULL")).rows[0].n);

    /** Every message on APP_NOTES from `fromSeq` on (a test-only ordered consumer). */
    async function messagesSince(fromSeq: number) {
      const last = await lastSeq();
      if (last < fromSeq) return [];
      const consumer = await jetstream(nc).consumers.get(STREAM, { opt_start_seq: fromSeq });
      const out: { subject: string; msgId?: string; event: CloudEvent }[] = [];
      for await (const m of await consumer.fetch({ max_messages: last - fromSeq + 1, expires: 2000 })) {
        out.push({ subject: m.subject, msgId: m.headers?.get("Nats-Msg-Id"), event: m.json<CloudEvent>() });
        if (m.seq >= last) break;
      }
      return out;
    }

    beforeAll(async () => {
      admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${dbName}`);
      const url = new URL(ADMIN_URL!);
      url.pathname = `/${dbName}`;
      process.env.DATABASE_URL = url.href;
      process.env.ASAFARIM_NATS_URL = NATS_URL;

      // What core-api does when it installs notes.
      streams = createStreamAdmin({ servers: NATS_URL! });
      await streams.ensureAppStream("notes");
      nc = await connect({ servers: NATS_URL!, maxReconnectAttempts: -1 });
      jsm = await jetstreamManager(nc);

      notes = await import("../lib/db");
      appPool = await notes.db();
      expect(notes.startEventRelay()).toBeDefined();
    });

    afterAll(async () => {
      await notes?.startEventRelay()?.stop();
      await appPool?.end();
      await streams?.close();
      await nc?.close();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
        await admin.end();
      }
    });

    it("create a note → exactly one event on APP_NOTES, with the CloudEvents envelope and the payload", async () => {
      const from = (await lastSeq()) + 1;
      const note = await notes.createNote("dev-member", "Hello bus", "the body isn't in the event");
      await expect.poll(pending, { timeout: 15_000 }).toBe(0);

      const msgs = await messagesSince(from);
      expect(msgs).toHaveLength(1);
      const [{ subject, msgId, event }] = msgs as [(typeof msgs)[number]];
      expect(subject).toBe(TYPE);
      expect(msgId).toBe(event.id);
      expect(event).toEqual({
        specversion: "1.0",
        id: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
        source: "asafarim://notes",
        type: TYPE,
        subject: String(note.id),
        time: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
        datacontenttype: "application/json",
        data: {
          id: String(note.id),
          author: "dev-member",
          title: "Hello bus",
          createdAt: note.created_at.toISOString(),
        },
      });
      // The outbox row is the same event, marked sent and kept.
      const row = (await appPool.query("SELECT id, sent_at FROM asafarim_outbox WHERE id = $1", [event.id])).rows[0];
      expect(row.sent_at).not.toBeNull();
    });

    it.skipIf(!CONTROL_NATS)(
      "bus down: NATS stopped, 3 notes created (rows wait in the outbox), NATS started → all 3 delivered once",
      async () => {
        const from = (await lastSeq()) + 1;
        natsContainer("stop");
        try {
          const created = [];
          for (const t of ["one", "two", "three"])
            created.push(await notes.createNote("dev-member", `Offline ${t}`, ""));
          expect(created).toHaveLength(3);
          // The relay keeps trying (and failing) while the bus is down; nothing is sent, nothing is lost.
          await new Promise((r) => setTimeout(r, 1500));
          expect(await pending()).toBe(3);
        } finally {
          natsContainer("start");
        }

        await expect.poll(pending, { timeout: 60_000, interval: 500 }).toBe(0);
        // The test's own connection reconnects too; wait for it before reading.
        await expect.poll(async () => (await lastSeq().catch(() => 0)) >= from + 2, { timeout: 30_000 }).toBe(true);
        const msgs = await messagesSince(from);
        const titles = msgs.map((m) => (m.event.data as { title: string }).title);
        expect(titles).toEqual(["Offline one", "Offline two", "Offline three"]);
        expect(new Set(msgs.map((m) => m.event.id)).size).toBe(3);
        const ids = (await appPool.query("SELECT id FROM asafarim_outbox ORDER BY seq DESC LIMIT 3")).rows.map(
          (r) => r.id,
        );
        expect(msgs.map((m) => m.event.id).sort()).toEqual(ids.sort());
      },
      120_000,
    );
  },
);
