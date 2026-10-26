/**
 * The JSON Schemas of the events docs publishes, keyed by the path the manifest references
 * (`events.publishes[].schema`). The publisher validates against them (lib/events.ts), and the SDK
 * uploads them for the Admin event catalog after registering (lib/platform.ts).
 */
import noteCreated from "../events/docs.note.created.v1.json";

export const EVENT_SCHEMAS: Record<string, object> = {
  "./events/docs.note.created.v1.json": noteCreated,
};
