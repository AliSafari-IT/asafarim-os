/**
 * The JSON Schemas of the events Flow publishes, keyed by the path the manifest references
 * (`events.publishes[].schema`). The publisher validates against them (lib/events.ts), and the SDK
 * uploads them for the Admin event catalog after registering (lib/platform.ts).
 */
import issueApproved from "../events/flow.issue.approved.v1.json";
import issueDraftRequested from "../events/flow.issue-draft.requested.v1.json";

export const EVENT_SCHEMAS: Record<string, object> = {
  "./events/flow.issue-draft.requested.v1.json": issueDraftRequested,
  "./events/flow.issue.approved.v1.json": issueApproved,
};
