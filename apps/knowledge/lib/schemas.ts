/**
 * The JSON Schemas of the events Knowledge publishes, keyed by the path the manifest references
 * (`events.publishes[].schema`). The publisher validates against them (lib/events.ts), and the SDK uploads them for
 * the Admin event catalog after registering (lib/platform.ts).
 */

import articleComment from "../events/knowledge.comment.created.v2.json";

export const EVENT_SCHEMAS: Record<string, object> = {
  "./events/knowledge.comment.created.v2.json": articleComment,
};
