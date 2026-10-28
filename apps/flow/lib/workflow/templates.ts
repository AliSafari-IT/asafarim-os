/**
 * Placeholders, `{{trigger.<path>}}` and `{{steps.<key>.output[.<path>]}}`, in a node's templated text
 * fields. Deliberately not a template language:
 *
 * - Only a field the node's schema marks with `templatedText()` takes them; a `{{` anywhere else in the
 *   node is refused by validation (lib/workflow/definition-v2.ts), as is a placeholder that reads a node
 *   that isn't upstream of this one on every path.
 * - Each is replaced as plain text, once, in one pass: a string as it is, any other value as its JSON. A
 *   value that itself contains `{{` is never evaluated again, so data can't inject a placeholder.
 * - A value that is missing (or null) fails the step with `missing_value`: nothing is sent half-filled.
 */
import { z } from "zod";
import { FIELD_PATH, resolveField, type RunContext } from "./context";

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** The schemas `templatedText()` made: the only fields that take placeholders. */
const templated = z.registry<{ templated: true }>();

/**
 * A text field that takes placeholders. Use it as it is (`.optional()` around it is fine); a refinement
 * on it (`.min(1)`) makes a new schema that isn't marked.
 */
export function templatedText(max = 10_000): z.ZodString {
  const schema = z.string().max(max);
  templated.add(schema, { templated: true });
  return schema;
}

export class MissingValueError extends Error {
  override readonly name = "MissingValueError";
  constructor(readonly path: string) {
    super(`{{${path}}} has no value in this run`);
  }
}

/** The paths of the placeholders in `text`, and what is wrong with it (a malformed or unknown placeholder). */
export function placeholdersIn(text: string): { paths: string[]; problems: string[] } {
  const paths: string[] = [];
  const problems: string[] = [];
  for (const [, inner] of text.matchAll(PLACEHOLDER)) {
    const path = inner!.trim();
    if (FIELD_PATH.test(path)) paths.push(path);
    else problems.push(`{{${inner}}} isn't {{trigger.<field>}} or {{steps.<key>.output.<field>}}`);
  }
  if (text.replace(PLACEHOLDER, "").includes("{{")) problems.push("has a {{ that doesn't close a placeholder");
  return { paths, problems };
}

/** `text` with each placeholder replaced by its value, in one pass. Throws MissingValueError. */
export function render(text: string, ctx: RunContext): string {
  return text.replace(PLACEHOLDER, (_, inner: string) => {
    const path = inner.trim();
    const value = resolveField(ctx, path);
    if (value === undefined || value === null) throw new MissingValueError(path);
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

type Path = (string | number)[];
type Visit = (path: Path, text: string, isTemplated: boolean) => string | void;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The schema under optional, nullable and default wrappers. */
function unwrap(schema: z.ZodType): z.ZodType {
  let s = schema;
  for (;;) {
    if (templated.has(s)) return s;
    const def = s.def as { type: string; innerType?: z.ZodType };
    if ((def.type === "optional" || def.type === "nullable" || def.type === "default") && def.innerType) {
      s = def.innerType;
    } else return s;
  }
}

/**
 * Every string in `value`, walked along `schema` (objects and arrays): `visit` learns whether the
 * schema marks it templated, and what it returns replaces it. A new value; `value` is left as it was.
 */
export function walkStrings(schema: z.ZodType | undefined, value: unknown, visit: Visit, path: Path = []): unknown {
  const s = schema ? unwrap(schema) : undefined;
  if (typeof value === "string") {
    const out = visit(path, value, s !== undefined && templated.has(s));
    return out ?? value;
  }
  const def = s?.def as { type?: string; shape?: Record<string, z.ZodType>; element?: z.ZodType } | undefined;
  if (Array.isArray(value)) {
    const element = def?.type === "array" ? def.element : undefined;
    return value.map((v, i) => walkStrings(element, v, visit, [...path, i]));
  }
  if (isRecord(value)) {
    const shape = def?.type === "object" ? def.shape : undefined;
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, walkStrings(shape?.[k], v, visit, [...path, k])]),
    );
  }
  return value;
}

/** `input` with the placeholders of its templated fields replaced. Throws MissingValueError. */
export function renderInput(schema: z.ZodType, input: unknown, ctx: RunContext): unknown {
  return walkStrings(schema, input, (_, text, isTemplated) => (isTemplated ? render(text, ctx) : undefined));
}
