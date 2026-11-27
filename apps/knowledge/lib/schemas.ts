/**
 * The JSON Schemas of the events Knowledge publishes, keyed by the path the manifest references
 * (`events.publishes[].schema`). The publisher validates against them (lib/events.ts), and the SDK uploads them for
 * the Admin event catalog after registering (lib/platform.ts).
 */
import commentCreated from "../events/knowledge.comment.created.v1.json";

export const EVENT_SCHEMAS: Record<string, object> = {
  "./events/knowledge.comment.created.v1.json": commentCreated,
};
