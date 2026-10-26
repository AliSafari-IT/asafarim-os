/**
 * The events docs publishes (Flow, ADR 0001). The publisher checks every payload against the JSON
 * Schema the manifest references before anything is written; lib/notes.ts publishes inside the
 * note's own transaction. Each event carries the W3C trace context of the request that caused it;
 * with telemetry off it carries none.
 */
import { createPublisher } from "@asafarim/app-sdk/events";
import { activeTraceContext } from "@asafarim/telemetry";
import manifest from "../platform.app";
import { EVENT_SCHEMAS } from "./schemas";

export const NOTE_CREATED = "docs.note.created.v1";

/** What `docs.note.created.v1` carries (events/docs.note.created.v1.json): never the body or the quote. */
export interface NoteCreatedV1 {
  id: string;
  author: string;
  docPath: string;
  tags: string[];
  hasIssue: boolean;
  createdAt: string;
}

export const publisher = createPublisher({
  manifest,
  schemas: EVENT_SCHEMAS,
  traceContext: activeTraceContext,
});
