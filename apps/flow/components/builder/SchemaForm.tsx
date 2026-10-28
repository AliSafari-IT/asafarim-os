"use client";
/**
 * A settings form made from a node's JSON Schema (lib/builder/catalog.ts, from its Zod schema): a
 * field per property, by its type. Text that takes placeholders gets their autocomplete, a
 * credential field a picker of the credentials of its kind (names only), a list its rows, a JSON value
 * (webhook.send's body) a JSON editor. What it writes is checked on the server; each field shows the
 * problems found at its path.
 */
import { useEffect, useState } from "react";
import { defaultOf, isJsonValue, resolve } from "@/lib/builder/defaults";
import type { Suggestion } from "@/lib/builder/suggest";
import type { CredentialRef, JsonSchema, Problem } from "@/lib/builder/types";
import { TemplatedInput } from "./TemplatedInput";

export interface FormContext {
  credentials: readonly CredentialRef[];
  suggestions: readonly Suggestion[];
  editable: boolean;
  defs?: Record<string, JsonSchema>;
  problems: readonly Problem[];
  /** Fields drawn by the caller instead (an approval's draft, a condition's clauses): by property name. */
  custom?: Record<string, (value: unknown, onChange: (v: unknown) => void, id: string) => React.ReactNode>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `subject` → "Subject", `onExpire` → "On expire". */
export function labelOf(name: string): string {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const idOf = (prefix: string, path: string) => `${prefix}-${path.replace(/[^A-Za-z0-9_-]/g, "-")}`;

function FieldProblems({ id, problems }: { id: string; problems: readonly Problem[] }) {
  if (!problems.length) return null;
  return (
    <ul id={id} className="field-problems" data-testid="field-problems">
      {problems.map((p, i) => (
        <li key={i}>{p.message}</li>
      ))}
    </ul>
  );
}

/** The problems at `path` itself (not inside it: those show on the field they are about). */
const at = (problems: readonly Problem[], path: string) => problems.filter((p) => p.path === path);

function JsonEditor({
  id,
  value,
  onChange,
  disabled,
  describedBy,
}: {
  id: string;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled: boolean;
  describedBy?: string;
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [bad, setBad] = useState(false);
  useEffect(() => {
    // A change from outside (another field, a reload): show it, unless it is what the text says.
    setText((t) => {
      try {
        if (JSON.stringify(JSON.parse(t)) === JSON.stringify(value)) return t;
      } catch {
        /* the text isn't JSON yet: replaced below */
      }
      return JSON.stringify(value ?? null, null, 2);
    });
  }, [value]);
  return (
    <>
      <textarea
        id={id}
        className="mono"
        rows={6}
        value={text}
        disabled={disabled}
        spellCheck={false}
        aria-invalid={bad || undefined}
        aria-describedby={[describedBy, bad ? `${id}-json` : undefined].filter(Boolean).join(" ") || undefined}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad ? (
        <p id={`${id}-json`} className="field-problems">
          Not valid JSON yet: it isn&apos;t saved until it is.
        </p>
      ) : null}
    </>
  );
}

function Field({
  name,
  schema: raw,
  value,
  onChange,
  path,
  required,
  prefix,
  ctx,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  onChange: (v: unknown) => void;
  path: string;
  required: boolean;
  prefix: string;
  ctx: FormContext;
}) {
  const schema = resolve(raw, ctx.defs);
  const id = idOf(prefix, path);
  const problems = at(ctx.problems, path);
  const problemsId = problems.length ? `${id}-problems` : undefined;
  const label = (
    <label htmlFor={id}>
      {labelOf(name)}
      {required ? <span className="muted"> (required)</span> : null}
    </label>
  );
  const disabled = !ctx.editable;
  const custom = ctx.custom?.[name];

  let control: React.ReactNode;
  if (custom) control = custom(value, onChange, id);
  else if (schema["x-credential"]) {
    const kind = schema["x-credential"];
    const options = ctx.credentials.filter((c) => c.kind === kind);
    const known = typeof value === "string" && options.some((c) => c.id === value);
    control = (
      <select
        id={id}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={problemsId}
        aria-invalid={problems.length ? true : undefined}
      >
        <option value="">Choose a {kind} credential…</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
        {!known && typeof value === "string" && value ? <option value={value}>(a credential not listed)</option> : null}
      </select>
    );
  } else if (isJsonValue(schema) || schema.$ref) {
    control = <JsonEditor id={id} value={value} onChange={onChange} disabled={disabled} describedBy={problemsId} />;
  } else if (schema.anyOf || schema.oneOf) {
    // A scalar that may also be a placeholder (an issue number: 12, or {{steps.create.output.number}}).
    const options = (schema.anyOf ?? schema.oneOf)!.map((o) => resolve(o, ctx.defs));
    const numeric = options.some((o) => o.type === "integer" || o.type === "number");
    const text = value === undefined || value === null ? "" : String(value);
    const set = (t: string) => onChange(numeric && /^\d+$/.test(t.trim()) ? Number(t.trim()) : t);
    control = options.some((o) => o["x-templated"]) ? (
      <TemplatedInput
        id={id}
        value={text}
        onChange={set}
        suggestions={ctx.suggestions}
        disabled={disabled}
        describedBy={problemsId}
        invalid={!!problems.length}
      />
    ) : (
      <input
        id={id}
        value={text}
        onChange={(e) => set(e.target.value)}
        disabled={disabled}
        aria-describedby={problemsId}
      />
    );
  } else if ("const" in schema) {
    control = <input id={id} value={String(schema.const)} readOnly aria-describedby={problemsId} />;
  } else if (schema.enum) {
    control = (
      <select
        id={id}
        value={value === undefined ? "" : String(value)}
        disabled={disabled}
        onChange={(e) => onChange(schema.enum!.find((o) => String(o) === e.target.value))}
        aria-describedby={problemsId}
      >
        {value === undefined ? <option value="">—</option> : null}
        {schema.enum.map((o) => (
          <option key={String(o)} value={String(o)}>
            {String(o)}
          </option>
        ))}
      </select>
    );
  } else if (schema.type === "string") {
    const text = typeof value === "string" ? value : "";
    control = schema["x-templated"] ? (
      <TemplatedInput
        id={id}
        value={text}
        onChange={onChange}
        suggestions={ctx.suggestions}
        multiline={(schema.maxLength ?? 0) > 500}
        maxLength={schema.maxLength}
        disabled={disabled}
        describedBy={problemsId}
        invalid={!!problems.length}
      />
    ) : (
      <input
        id={id}
        value={text}
        maxLength={schema.maxLength}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={problemsId}
        aria-invalid={problems.length ? true : undefined}
      />
    );
  } else if (schema.type === "number" || schema.type === "integer") {
    control = (
      <input
        id={id}
        type="number"
        step={schema.type === "integer" ? 1 : "any"}
        value={typeof value === "number" ? value : ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        aria-describedby={problemsId}
      />
    );
  } else if (schema.type === "boolean") {
    return (
      <div className="field">
        <p className="check">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
          <label htmlFor={id}>{labelOf(name)}</label>
        </p>
        <FieldProblems id={`${id}-problems`} problems={problems} />
      </div>
    );
  } else if (schema.type === "array" && schema.items) {
    return (
      <ListField
        name={name}
        schema={schema}
        value={value}
        onChange={onChange}
        path={path}
        prefix={prefix}
        ctx={ctx}
        required={required}
      />
    );
  } else if (schema.type === "object" && schema.properties) {
    return (
      <fieldset className="field">
        <legend>{labelOf(name)}</legend>
        <SchemaFields schema={schema} value={value} onChange={onChange} path={path} prefix={prefix} ctx={ctx} />
        <FieldProblems id={`${id}-problems`} problems={problems} />
      </fieldset>
    );
  } else {
    control = <JsonEditor id={id} value={value} onChange={onChange} disabled={disabled} describedBy={problemsId} />;
  }
  return (
    <div className="field">
      {label}
      {control}
      <FieldProblems id={`${id}-problems`} problems={problems} />
    </div>
  );
}

function ListField({
  name,
  schema,
  value,
  onChange,
  path,
  prefix,
  ctx,
  required,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  onChange: (v: unknown) => void;
  path: string;
  prefix: string;
  ctx: FormContext;
  required: boolean;
}) {
  const items = Array.isArray(value) ? value : [];
  const item = resolve(schema.items!, ctx.defs);
  const id = idOf(prefix, path);
  const problems = at(ctx.problems, path);
  const legend = (
    <legend>
      {labelOf(name)}
      {required ? <span className="muted"> (required)</span> : null}
    </legend>
  );
  // A set of choices (an approval's editable fields): one checkbox each.
  if (item.enum) {
    return (
      <fieldset className="field">
        {legend}
        {item.enum.map((o) => (
          <p key={String(o)} className="check">
            <input
              id={`${id}-${String(o)}`}
              type="checkbox"
              checked={items.includes(o)}
              disabled={!ctx.editable}
              onChange={(e) => onChange(e.target.checked ? [...items, o] : items.filter((x) => x !== o))}
            />
            <label htmlFor={`${id}-${String(o)}`}>{String(o)}</label>
          </p>
        ))}
        <FieldProblems id={`${id}-problems`} problems={problems} />
      </fieldset>
    );
  }
  const full = schema.maxItems !== undefined && items.length >= schema.maxItems;
  return (
    <fieldset className="field">
      {legend}
      {items.map((v, i) => (
        <div key={i} className="list-row">
          <Field
            name={`${name} ${i + 1}`}
            schema={item}
            value={v}
            onChange={(nv) => onChange(items.map((x, j) => (j === i ? nv : x)))}
            path={`${path}.${i}`}
            required={false}
            prefix={prefix}
            ctx={ctx}
          />
          {ctx.editable ? (
            <button
              type="button"
              className="secondary small"
              aria-label={`Remove ${labelOf(name).toLowerCase()} ${i + 1}`}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          ) : null}
        </div>
      ))}
      {ctx.editable ? (
        <button
          type="button"
          className="secondary small"
          disabled={full}
          onClick={() => onChange([...items, defaultOf(item, ctx.defs)])}
        >
          Add {labelOf(name).toLowerCase().replace(/s$/, "")}
        </button>
      ) : null}
      <FieldProblems id={`${id}-problems`} problems={problems} />
    </fieldset>
  );
}

/** A field per property of `schema` (an object), in its order; `skip`: properties drawn elsewhere. */
export function SchemaFields({
  schema,
  value,
  onChange,
  path,
  prefix,
  ctx,
  skip = [],
}: {
  schema: JsonSchema;
  value: unknown;
  onChange: (v: Record<string, unknown>) => void;
  /** Where these fields are in the node (`input` for a connector), for the problems. */
  path: string;
  prefix: string;
  ctx: FormContext;
  skip?: readonly string[];
}) {
  const object = isRecord(value) ? value : {};
  const required = new Set(schema.required ?? []);
  return (
    <>
      {Object.entries(schema.properties ?? {})
        .filter(([k]) => !skip.includes(k))
        .map(([k, p]) => (
          <Field
            key={k}
            name={k}
            schema={p}
            value={object[k]}
            path={path ? `${path}.${k}` : k}
            required={required.has(k)}
            prefix={prefix}
            ctx={ctx}
            onChange={(v) => {
              const next = { ...object, [k]: v };
              // An optional field left empty is left out.
              if (!required.has(k) && (v === undefined || v === "")) delete next[k];
              onChange(next);
            }}
          />
        ))}
    </>
  );
}
