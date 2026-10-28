/**
 * The "Run now" form of a workflow with a manual trigger: one form field per input field, named
 * `input.<name>`, with its type (`input-type.<name>`) beside it so the posted text is read back as what
 * the engine checks (lib/workflow/definition-v2.ts `inputProblems`): a number as a number, a checkbox
 * as a boolean, an empty field as absent.
 */
const PREFIX = "input.";
const TYPE_PREFIX = "input-type.";

export const fieldName = (name: string) => `${PREFIX}${name}`;
export const typeFieldName = (name: string) => `${TYPE_PREFIX}${name}`;

export function manualInputOf(form: FormData): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, type] of form.entries()) {
    if (!key.startsWith(TYPE_PREFIX) || typeof type !== "string") continue;
    const name = key.slice(TYPE_PREFIX.length);
    const raw = form.get(fieldName(name));
    if (type === "boolean") {
      data[name] = raw === "on";
      continue;
    }
    if (typeof raw !== "string" || raw.trim() === "") continue;
    // A number that isn't one stays text, which the engine refuses as not a number.
    data[name] = type === "number" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  return data;
}
