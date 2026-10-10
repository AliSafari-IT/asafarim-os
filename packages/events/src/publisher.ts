/**
 * Publishing (ADR 0001 §5, P4.1): `publish(tx, type, data)` validates the payload against the JSON
 * Schema the manifest references for that type, builds the CloudEvents envelope and writes ONE
 * outbox row through the caller's own transaction. Nothing is sent here: the relay does that
 * after commit, so the event exists exactly when the change that caused it does (no dual write).
 *
 * An undeclared type or an invalid payload is a programming error: it throws before any write.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { createEvent, type CloudEvent } from "./envelope.ts";
import { OUTBOX_TABLE } from "./outbox-sql.ts";

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
  /** W3C traceparent of the request that caused the event. */
  traceparent?: string;
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

  return {
    appId,
    types: [...validators.keys()],
    validate,
    async publish<T>(tx: Queryable, type: string, data: T, o: PublishOptions = {}) {
      validate(type, data);
      const event = createEvent({
        source: appId,
        type,
        data,
        subject: o.subject,
        traceparent: o.traceparent,
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
