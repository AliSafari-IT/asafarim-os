/**
 * The JSON Schemas of the events docs publishes, keyed by the path the manifest references
 * (`events.publishes[].schema`). The publisher validates against them (lib/events.ts), and the SDK
 * uploads them for the Admin event catalog after registering (lib/platform.ts).
 */
import issueDraftFailed from "../events/docs.issue-draft.failed.v1.json";
import issueDraftReady from "../events/docs.issue-draft.ready.v1.json";
import issueCreated from "../events/docs.issue.created.v1.json";
import issueFailed from "../events/docs.issue.failed.v1.json";
import noteCreated from "../events/docs.note.created.v1.json";

export const EVENT_SCHEMAS: Record<string, object> = {
  "./events/docs.note.created.v1.json": noteCreated,
  "./events/docs.issue-draft.ready.v1.json": issueDraftReady,
  "./events/docs.issue-draft.failed.v1.json": issueDraftFailed,
  "./events/docs.issue.created.v1.json": issueCreated,
  "./events/docs.issue.failed.v1.json": issueFailed,
};
