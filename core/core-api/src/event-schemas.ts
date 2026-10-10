/**
 * The event catalog's schemas (P4.2, ADR 0001 §5): an app uploads the JSON Schema of every type it
 * publishes (signed `PUT /registry/v1/apps/:id/event-schemas`, after it registers), and the Admin
 * catalog is built from them. Pure: this module checks an upload against the app's current manifest;
 * the registry stores it.
 *
 * Rules, each refused with `invalid_event_schemas` naming the type (or 413 when too large):
 *  - the body is `{ "schemas": { "<type>": <JSON Schema object> } }`;
 *  - its keys are exactly the types the app's current manifest publishes (no missing, no extra);
 *  - each schema is a JSON object that compiles with the publisher's own ajv setup (@asafarim/events);
 *  - each schema is at most MAX_SCHEMA_BYTES; the whole request at most MAX_SCHEMAS_REQUEST_BYTES.
 */
import { compileEventSchema } from "@asafarim/events";
import { ApiError } from "./errors.ts";
import { publishedTypes, type EventsManifest } from "./event-plumbing.ts";

/** One schema, serialised. */
export const MAX_SCHEMA_BYTES = 64 * 1024;
/** One upload request body. */
export const MAX_SCHEMAS_REQUEST_BYTES = 512 * 1024;

export interface SchemaProblem {
  type: string;
  message: string;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Check an upload body (already parsed JSON) against the manifest. Returns the schemas by type, sorted. */
export function checkEventSchemas(manifest: EventsManifest | null, input: unknown): Record<string, object> {
  if (!isObject(input) || !isObject(input.schemas)) {
    throw new ApiError("invalid_event_schemas", 'the body must be { "schemas": { "<event type>": <JSON Schema> } }');
  }
  const given = input.schemas;
  const declared = publishedTypes(manifest);
  const declaredSet = new Set(declared);
  const problems: SchemaProblem[] = [];
  for (const type of declared) {
    if (!Object.hasOwn(given, type)) problems.push({ type, message: "missing: the manifest publishes it" });
  }
  for (const type of Object.keys(given).sort()) {
    if (!declaredSet.has(type)) problems.push({ type, message: "extra: the manifest doesn't publish it" });
  }
  if (problems.length) throw refusal(problems);

  const out: Record<string, object> = {};
  for (const type of declared) {
    const schema = given[type];
    if (!isObject(schema)) {
      problems.push({ type, message: "the schema must be a JSON object" });
      continue;
    }
    const bytes = Buffer.byteLength(JSON.stringify(schema), "utf8");
    if (bytes > MAX_SCHEMA_BYTES) {
      throw new ApiError("payload_too_large", `the schema for ${type} is ${bytes} bytes; at most ${MAX_SCHEMA_BYTES}`, [
        { type, message: `larger than ${MAX_SCHEMA_BYTES} bytes` },
      ]);
    }
    try {
      compileEventSchema(schema);
    } catch (err) {
      problems.push({ type, message: `doesn't compile: ${(err as Error).message}` });
      continue;
    }
    out[type] = schema;
  }
  if (problems.length) throw refusal(problems);
  return out;
}

function refusal(problems: SchemaProblem[]) {
  return new ApiError(
    "invalid_event_schemas",
    `the event schemas don't match the manifest: ${problems.map((p) => `${p.type} (${p.message})`).join(", ")}`,
    problems,
  );
}
