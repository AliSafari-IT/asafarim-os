/**
 * The JSON Schemas of the events notes publishes, keyed by the path the manifest references
 * (`events.publishes[].schema`). The publisher validates against them (lib/events.ts), and the SDK
 * uploads them for the Admin event catalog after registering (lib/platform.ts, P4.2).
 */
import noteCreated from "../events/notes.note.created.v1.json";

export const EVENT_SCHEMAS: Record<string, object> = {
  "./events/notes.note.created.v1.json": noteCreated,
};
