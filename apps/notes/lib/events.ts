/**
 * The events notes publishes (P4.1). The publisher checks every payload against the JSON Schema the
 * manifest references before anything is written; lib/db.ts publishes inside the insert's transaction.
 * Each event carries the W3C trace context of the request that created it (P6 part 2a); with
 * telemetry off it carries none.
 */
import { createPublisher } from "@asafarim/app-sdk/events";
import { activeTraceContext } from "@asafarim/telemetry";
import manifest from "../platform.app";
import { EVENT_SCHEMAS } from "./schemas";

export const NOTE_CREATED = "notes.note.created.v1";

/** What `notes.note.created.v1` carries (events/notes.note.created.v1.json). */
export interface NoteCreatedV1 {
  id: string;
  author: string;
  title: string;
  createdAt: string;
}

export const publisher = createPublisher({
  manifest,
  schemas: EVENT_SCHEMAS,
  traceContext: activeTraceContext,
});
