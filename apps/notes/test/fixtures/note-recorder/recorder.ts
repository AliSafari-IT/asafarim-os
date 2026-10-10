/**
 * TEST FIXTURE, not a product app: a subscriber of `notes.note.created.v1` that records every event
 * it handles, so the P4.1 integration test can check that a created note reaches a subscriber
 * exactly once. It lives under notes' tests (it imports nothing from notes) and is never deployed.
 *
 * Like a real consuming app it has its own database (the inbox and its `received` table), and its
 * durable consumer is created by core-api (here: by the test, the way core-api does it).
 */
import { INBOX_SQL, subscribe, type BusAuth, type RelayLogger, type Subscription } from "@asafarim/app-sdk/events";
import type pg from "pg";

export const RECORDER_ID = "note-recorder";
export const NOTE_CREATED = "notes.note.created.v1";

/** Its manifest: its own database, one subscription (what core-api creates the durable consumer from). */
export const recorderManifest = {
  id: RECORDER_ID,
  name: "Note recorder (test fixture)",
  version: "0.0.0",
  platform: ">=0.1 <1",
  owner: "ASafariM Digital",
  runtime: {
    image: RECORDER_ID,
    port: 3000,
    health: { live: "/healthz", ready: "/readyz" },
    resources: { memory: "64m", cpus: 0.1 },
  },
  database: { engine: "postgres", migrations: "sql" },
  auth: { client: "oidc", publicPaths: [] },
  permissions: [{ key: `${RECORDER_ID}.read`, description: "Read what was recorded" }],
  roles: [{ key: `${RECORDER_ID}.viewer`, grants: [`${RECORDER_ID}.read`] }],
  events: { subscribes: [{ type: NOTE_CREATED, handler: "/internal/events/notes.note.created.v1" }] },
  ui: { glyph: "NR", color: "#64748b", nav: [], status: "coming-soon" },
};

export const RECORDER_SQL = `${INBOX_SQL}
CREATE TABLE IF NOT EXISTS received (
  event_id    text PRIMARY KEY,
  envelope    jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);`;

export interface Recorder {
  subscription: Subscription;
  /** How often the handler ran (a committed or a rolled-back run alike). */
  readonly calls: number;
}

/** Start consuming; the handler writes the envelope to `received` in the inbox's transaction. */
export function startRecorder(opts: {
  pool: pg.Pool;
  servers: string;
  /** The recorder's identity on a bus that checks identities (P4.1 PR 4). */
  auth?: BusAuth;
  log?: RelayLogger;
}): Recorder {
  let calls = 0;
  const subscription = subscribe(
    NOTE_CREATED,
    async (event, tx) => {
      calls++;
      await tx.query("INSERT INTO received (event_id, envelope) VALUES ($1, $2)", [event.id, JSON.stringify(event)]);
    },
    { appId: RECORDER_ID, pool: opts.pool, servers: opts.servers, auth: opts.auth, log: opts.log },
  );
  return {
    subscription,
    get calls() {
      return calls;
    },
  };
}
