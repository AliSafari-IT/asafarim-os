/**
 * The events Flow publishes (ADR 0001). The publisher checks every payload against the JSON Schema the
 * manifest references before anything is written; the engine publishes inside the transaction of the
 * transition that sends it. Each event carries the W3C trace context of the request that caused it;
 * with telemetry off it carries none.
 */
import { createPublisher } from "@asafarim/app-sdk/events";
import { activeTraceContext } from "@asafarim/telemetry";
import manifest from "../platform.app";
import { EVENT_SCHEMAS } from "./schemas";

export const publisher = createPublisher({
  manifest,
  schemas: EVENT_SCHEMAS,
  traceContext: activeTraceContext,
});
