import type { Catalog, Draft, JsonSchema } from "./types";

export const WORKFLOW_FILE_FORMAT = "asafarim.flow.workflow";
export const WORKFLOW_FILE_VERSION = 1;
export const WORKFLOW_FILE_MAX_BYTES = 256 * 1024;
export const IMPORT_PLACEHOLDER_CREDENTIAL = "import_placeholder";
export const IMPORT_PLACEHOLDER_HOOK = "import_placeholder_000";
export const WORKFLOW_SENSITIVE_KEY = /(?:secret|password|token|api[_-]?key|credential(?:id|value)?|webhook.?id)/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface WorkflowFile {
  format: typeof WORKFLOW_FILE_FORMAT;
  version: typeof WORKFLOW_FILE_VERSION;
  exportedAt: string;
  definition: Draft;
}

function scrubValue(value: unknown, schema: JsonSchema | undefined, path: readonly string[]): unknown {
  if (schema?.["x-credential"]) return IMPORT_PLACEHOLDER_CREDENTIAL;
  if (schema?.["x-recipient"]) return "recipient@example.invalid";
  if (schema?.["x-egress"]) return "https://example.invalid/";
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, schema?.items, path));
  if (!isRecord(value)) return value;

  const properties = schema?.properties ?? {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => {
        if (key === "hook" && path.join(".") === "trigger") return true;
        if (schema?.properties?.[key]?.["x-credential"]) return true;
        return !WORKFLOW_SENSITIVE_KEY.test(key);
      })
      .map(([key, child]) => [
        key,
        key === "hook" && path.join(".") === "trigger"
          ? IMPORT_PLACEHOLDER_HOOK
          : scrubValue(child, properties[key], [...path, key]),
      ]),
  );
}

/** A portable copy of a draft: all instance credentials and allow-list values are placeholders. */
export function exportWorkflowFile(
  draft: Draft,
  catalog: Catalog,
  exportedAt = new Date().toISOString(),
): WorkflowFile {
  const triggerSpec = catalog.triggers.find((item) => item.type === draft.trigger.type);
  const trigger = scrubValue(draft.trigger, triggerSpec?.settings, ["trigger"]) as Record<string, unknown>;
  const nodes = draft.nodes.map((node) => {
    const spec = catalog.nodes.find((item) => item.type === node.type);
    if (!spec) return scrubValue(node, undefined, ["nodes"]) as Draft["nodes"][number];
    if (spec.connector) {
      return {
        ...(scrubValue(node, undefined, ["nodes"]) as Record<string, unknown>),
        input: scrubValue(node.input, spec.settings, ["nodes", String(node.key), "input"]),
      } as Draft["nodes"][number];
    }
    return scrubValue(node, spec.settings, ["nodes", String(node.key)]) as Draft["nodes"][number];
  });
  return {
    format: WORKFLOW_FILE_FORMAT,
    version: WORKFLOW_FILE_VERSION,
    exportedAt,
    definition: { ...draft, trigger, nodes },
  };
}
