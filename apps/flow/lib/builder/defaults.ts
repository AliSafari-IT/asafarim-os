/** The value a new node's field starts with, from its JSON Schema (lib/builder/catalog.ts). Pure. */
import type { JsonSchema } from "./types";

/** `schema` with a `$ref` into `defs` resolved. */
export function resolve(schema: JsonSchema, defs: Record<string, JsonSchema> | undefined): JsonSchema {
  if (schema.$ref?.startsWith("#/$defs/")) return defs?.[schema.$ref.slice("#/$defs/".length)] ?? {};
  return schema;
}

/** A JSON value's schema: a union that takes both arrays and objects (webhook.send's `body`). */
export function isJsonValue(schema: JsonSchema): boolean {
  const options = schema.anyOf ?? schema.oneOf;
  return !!options?.some((o) => o.type === "array") && !!options.some((o) => o.type === "object");
}

export function defaultOf(schema: JsonSchema, defs: Record<string, JsonSchema> | undefined = schema.$defs): unknown {
  const s = resolve(schema, defs);
  if ("default" in s) return structuredClone(s.default);
  if ("const" in s) return s.const;
  if (s.enum?.length) return s.enum[0];
  if (isJsonValue(s)) return {};
  const options = s.anyOf ?? s.oneOf;
  if (options?.length) return defaultOf(options.find((o) => o.type === "string") ?? options[0]!, defs);
  switch (s.type) {
    case "object":
      return Object.fromEntries(
        Object.entries(s.properties ?? {})
          .filter(([k, p]) => (s.required ?? []).includes(k) || "default" in resolve(p, defs))
          .map(([k, p]) => [k, defaultOf(p, defs)]),
      );
    case "array":
      return Array.from({ length: s.minItems ?? 0 }, () => (s.items ? defaultOf(s.items, defs) : null));
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "string":
      return "";
    default:
      return null;
  }
}
