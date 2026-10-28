/**
 * Publishing (ADR 0001 §5, P4.1): `publish(tx, type, data)` validates the payload against the JSON
 * Schema the manifest references for that type, builds the CloudEvents envelope and writes ONE
 * outbox row through the caller's own transaction. Nothing is sent here: the relay does that
 * after commit, so the event exists exactly when the change that caused it does (no dual write).
 *
 * An undeclared type or an invalid payload is a programming error: it throws before any write.
 *
 * Tracing (P6 part 2a): the envelope carries the W3C trace context of the request that published
 * it, captured HERE, at outbox-write time, so the relay (later, outside the request) sends the
 * original context. With no context (telemetry off, no active span) nothing is added.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { createEvent, type CloudEvent } from "./envelope.ts";
import { OUTBOX_TABLE } from "./outbox-sql.ts";
import { traceContextOf, type TraceContext, type TraceContextSource } from "./trace-context.ts";

// ajv-formats is CommonJS with a default export; under NodeNext its default import is the module object.
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ??
  addFormatsModule) as unknown as (ajv: Ajv2020) => Ajv2020;

/** The part of a manifest publishing needs (structurally compatible with `AppManifest`). */
export interface PublishingManifest {
  id: string;
  events?: { publishes?: readonly { type: string; schema: string }[] };
}

/** Anything that runs a parameterised query: a `pg` PoolClient inside BEGIN … COMMIT, or a Drizzle/pg transaction wrapper. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export interface PublishOptions {
  /** CloudEvents `subject`: what the event is about inside the app (e.g. the note id). */
  subject?: string;
  /**
   * W3C traceparent of the request that caused the event. Given (with or without `tracestate`), it
   * replaces what the publisher's `traceContext` would capture, and a malformed one throws.
   */
  traceparent?: string;
  /** W3C tracestate, only with `traceparent`. */
  tracestate?: string;
}

export class EventValidationError extends Error {
  override readonly name = "EventValidationError";
  constructor(
    readonly type: string,
    readonly problems: { path: string; message: string }[],
  ) {
    super(`events: invalid ${type} payload: ${problems.map((p) => `${p.path || "/"} ${p.message}`).join("; ")}`);
  }
}

export class UndeclaredEventError extends Error {
  override readonly name = "UndeclaredEventError";
  constructor(
    readonly appId: string,
    readonly type: string,
  ) {
    super(`events: ${appId} doesn't declare "${type}" in events.publishes`);
  }
}

export interface Publisher {
  appId: string;
  /** The declared types, in manifest order. */
  types: string[];
  /** Throws EventValidationError / UndeclaredEventError; never writes. */
  validate(type: string, data: unknown): void;
  /** Validate, build the envelope, insert one outbox row with `tx`. Returns the event. */
  publish<T>(tx: Queryable, type: string, data: T, opts?: PublishOptions): Promise<CloudEvent<T>>;
}

export interface CreatePublisherOptions {
  manifest: PublishingManifest;
  /**
   * The JSON Schemas, keyed by the path the manifest references (`events.publishes[].schema`,
   * e.g. "./events/notes.note.created.v1.json"). `loadSchemas` reads them from disk.
   */
  schemas: Record<string, object>;
  /**
   * Captures the active request's W3C trace context for each event (`activeTraceContext` from
   * `@asafarim/telemetry`). An invalid value is ignored and a throwing source is ignored: tracing
   * never fails a publish. Without one, events carry only what `publish` is given.
   */
  traceContext?: TraceContextSource;
  /** For tests. */
  now?: () => Date;
}

/**
 * The ajv setup payloads are validated with (JSON Schema 2020-12, strict, ajv-formats). core-api
 * uses the same one to check the schemas an app uploads for the event catalog (P4.2), so a schema
 * the catalog accepts is one the publisher can compile.
 */
export function createSchemaAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv;
}

/**
 * The event catalog's upload limits (P4.2): core-api refuses one published type's schema larger
 * than this (`JSON.stringify` of the parsed schema, in UTF-8 bytes) with `payload_too_large` ...
 */
export const MAX_EVENT_SCHEMA_BYTES = 64 * 1024;
/** ... and a whole upload body (`{ "schemas": { "<type>": <schema> } }`, as the app SDK sends it) larger than this. */
export const MAX_EVENT_SCHEMAS_REQUEST_BYTES = 512 * 1024;

/** Compile one schema on a fresh ajv (so two schemas with the same `$id` never collide). Throws if it doesn't compile. */
export function compileEventSchema(schema: object): ValidateFunction {
  return createSchemaAjv().compile(schema);
}

export function createPublisher(opts: CreatePublisherOptions): Publisher {
  const appId = opts.manifest.id;
  const ajv = createSchemaAjv();
  const validators = new Map<string, ValidateFunction>();
  for (const { type, schema } of opts.manifest.events?.publishes ?? []) {
    const json = opts.schemas[schema];
    if (!json) throw new Error(`events: no JSON Schema given for ${type} (${schema})`);
    try {
      validators.set(type, ajv.compile(json));
    } catch (err) {
      throw new Error(`events: the JSON Schema for ${type} (${schema}) doesn't compile: ${(err as Error).message}`);
    }
  }

  function validate(type: string, data: unknown) {
    const check = validators.get(type);
    if (!check) throw new UndeclaredEventError(appId, type);
    if (!check(data)) {
      throw new EventValidationError(
        type,
        (check.errors ?? []).map((e) => ({ path: e.instancePath, message: e.message ?? "is invalid" })),
      );
    }
  }

  /** The context the source gives, validated; undefined when there is none or it is invalid. */
  function captured(): TraceContext | undefined {
    if (!opts.traceContext) return undefined;
    try {
      return traceContextOf(opts.traceContext());
    } catch {
      return undefined;
    }
  }

  return {
    appId,
    types: [...validators.keys()],
    validate,
    async publish<T>(tx: Queryable, type: string, data: T, o: PublishOptions = {}) {
      validate(type, data);
      const trace =
        o.traceparent !== undefined || o.tracestate !== undefined
          ? { traceparent: o.traceparent, tracestate: o.tracestate }
          : captured();
      const event = createEvent({
        source: appId,
        type,
        data,
        subject: o.subject,
        traceparent: trace?.traceparent,
        tracestate: trace?.tracestate,
        now: opts.now?.(),
      });
      await tx.query(`INSERT INTO ${OUTBOX_TABLE} (id, type, envelope) VALUES ($1, $2, $3)`, [
        event.id,
        event.type,
        JSON.stringify(event),
      ]);
      return event;
    },
  };
}

/** Read every schema the manifest references, relative to the app's directory. */
export function loadSchemas(manifest: PublishingManifest, appDir: string): Record<string, object> {
  const out: Record<string, object> = {};
  for (const { schema } of manifest.events?.publishes ?? []) {
    const file = path.resolve(appDir, schema);
    if (!file.startsWith(path.resolve(appDir) + path.sep)) throw new Error(`events: ${schema} is outside the app`);
    out[schema] = JSON.parse(readFileSync(file, "utf8")) as object;
  }
  return out;
}
