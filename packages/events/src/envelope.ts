/**
 * The event envelope (ADR 0001 §5): CloudEvents 1.0, structured JSON mode
 * (https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md), with the W3C
 * `traceparent` and `tracestate` carried as CloudEvents extension attributes (the distributed-tracing
 * extension; see trace-context.ts).
 */
import { TRACEPARENT, isTracestate } from "./trace-context.ts";
import { ulid } from "./ulid.ts";

/** `<app>.<entity>.<verb>.v<N>`, the same rule as the manifest's event types. */
export const EVENT_TYPE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.v[1-9]\d*$/;
/** An app id, as the manifest allows it: kebab-case, 2–32 characters. */
export const APP_ID = /^(?=.{2,32}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface CloudEvent<T = unknown> {
  specversion: "1.0";
  /** A ULID: unique per event, and the JetStream de-duplication key. */
  id: string;
  /** `asafarim://<app-id>`: the publishing app. */
  source: string;
  type: string;
  /** What the event is about inside the app (e.g. the note id). */
  subject?: string;
  /** RFC 3339, UTC. */
  time: string;
  datacontenttype: "application/json";
  data: T;
  /** W3C traceparent (CloudEvents distributed-tracing extension). */
  traceparent?: string;
  /** W3C tracestate (CloudEvents distributed-tracing extension); only next to a traceparent. */
  tracestate?: string;
}

export interface CreateEventInput<T> {
  /** The publishing app's id; becomes `source` = `asafarim://<appId>`. */
  source: string;
  type: string;
  subject?: string;
  data: T;
  traceparent?: string;
  /** Only with a traceparent. */
  tracestate?: string;
  /** For tests. */
  now?: Date;
  id?: string;
}

export const sourceFor = (appId: string) => `asafarim://${appId}`;

/** Build a CloudEvents 1.0 envelope. Throws on a malformed type, app id, subject, traceparent or tracestate. */
export function createEvent<T>(input: CreateEventInput<T>): CloudEvent<T> {
  if (!APP_ID.test(input.source)) throw new TypeError(`events: "${input.source}" is not an app id`);
  if (!EVENT_TYPE.test(input.type)) throw new TypeError(`events: "${input.type}" must be <app>.<entity>.<verb>.v<N>`);
  if (!input.type.startsWith(`${input.source}.`)) {
    throw new TypeError(`events: ${input.source} may only publish types in its own namespace ("${input.source}.*")`);
  }
  if (input.subject !== undefined && (typeof input.subject !== "string" || input.subject.length === 0)) {
    throw new TypeError("events: subject must be a non-empty string when given");
  }
  if (input.traceparent !== undefined && !TRACEPARENT.test(input.traceparent)) {
    throw new TypeError("events: traceparent is not a W3C version-00 traceparent");
  }
  if (input.tracestate !== undefined) {
    if (input.traceparent === undefined) throw new TypeError("events: a tracestate needs a traceparent");
    if (!isTracestate(input.tracestate)) throw new TypeError("events: tracestate is not a W3C tracestate");
  }
  const now = input.now ?? new Date();
  const event: CloudEvent<T> = {
    specversion: "1.0",
    id: input.id ?? ulid(now.getTime()),
    source: sourceFor(input.source),
    type: input.type,
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    time: now.toISOString(),
    datacontenttype: "application/json",
    data: input.data,
    ...(input.traceparent !== undefined ? { traceparent: input.traceparent } : {}),
    ...(input.tracestate !== undefined ? { tracestate: input.tracestate } : {}),
  };
  return event;
}
