/**
 * The events notes publishes (P4.1). The publisher checks every payload against the JSON Schema the
 * manifest references before anything is written; lib/db.ts publishes inside the insert's transaction.
 */
import { createPublisher } from "@asafarim/app-sdk/events";
import manifest from "../platform.app";
import noteCreated from "../events/notes.note.created.v1.json";

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
  schemas: { "./events/notes.note.created.v1.json": noteCreated },
});
