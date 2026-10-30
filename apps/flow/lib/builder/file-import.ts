import { parseDefinition, isV2 } from "../workflow/definition";
import { MAX_NODES } from "../workflow/definition-v2";
import type { WorkflowDefinition } from "../workflow/definition";
import { v1ToV2 } from "./v1";
import {
  IMPORT_PLACEHOLDER_CREDENTIAL,
  IMPORT_PLACEHOLDER_HOOK,
  WORKFLOW_FILE_FORMAT,
  WORKFLOW_FILE_MAX_BYTES,
  WORKFLOW_FILE_VERSION,
  WORKFLOW_SENSITIVE_KEY,
} from "./file";
import type { Draft } from "./types";

export type WorkflowFileResult = { ok: true; definition: Draft } | { ok: false; error: string; problems?: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function secretPaths(value: unknown, path: string[] = []): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => secretPaths(item, [...path, String(index)]));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = [...path, key];
    if (key === "credential" && child === IMPORT_PLACEHOLDER_CREDENTIAL) return [];
    if (key === "hook" && path.join(".") === "definition.trigger" && child === IMPORT_PLACEHOLDER_HOOK) return [];
    if (WORKFLOW_SENSITIVE_KEY.test(key) || (key === "hook" && path.join(".") === "definition.trigger"))
      return [childPath.join(".")];
    return secretPaths(child, childPath);
  });
}

/** Validate an untrusted workflow export before it reaches the builder or is saved. */
export function parseWorkflowFile(value: unknown): WorkflowFileResult {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { ok: false, error: "The workflow file isn't valid JSON." };
  }
  if (typeof serialized !== "string" || new TextEncoder().encode(serialized).byteLength > WORKFLOW_FILE_MAX_BYTES)
    return { ok: false, error: "The workflow file is too large (256 KiB maximum)." };
  if (!isRecord(value) || value.format !== WORKFLOW_FILE_FORMAT)
    return { ok: false, error: `Unsupported workflow file format. Expected "${WORKFLOW_FILE_FORMAT}".` };
  if (value.version !== WORKFLOW_FILE_VERSION)
    return { ok: false, error: `Unsupported workflow file version. Expected ${WORKFLOW_FILE_VERSION}.` };
  if (!isRecord(value.definition)) return { ok: false, error: "The workflow file has no definition object." };

  const secrets = secretPaths(value);
  if (secrets.length)
    return {
      ok: false,
      error: "The workflow file contains instance-specific credentials or secret fields. Export a clean copy first.",
      problems: secrets.map((path) => `${path}: remove this secret or replace it with an export placeholder.`),
    };

  const definition = value.definition;
  const nodeCount = Array.isArray(definition.nodes)
    ? definition.nodes.length
    : Array.isArray(definition.steps)
      ? definition.steps.length
      : 0;
  if (nodeCount > MAX_NODES)
    return { ok: false, error: `The workflow has ${nodeCount} nodes; the maximum is ${MAX_NODES}.` };

  const parsed = parseDefinition(definition);
  if (!parsed.ok) {
    return {
      ok: false,
      error: "The workflow definition is invalid. Fix every reported problem and try again.",
      problems: parsed.problems,
    };
  }
  const converted = isV2(parsed.definition) ? (definition as Draft) : v1ToV2(parsed.definition as WorkflowDefinition);
  const restorePlaceholders = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(restorePlaceholders);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        key === "credential" && child === IMPORT_PLACEHOLDER_CREDENTIAL
          ? ""
          : key === "hook" && child === IMPORT_PLACEHOLDER_HOOK && value === converted.trigger
            ? ""
            : restorePlaceholders(child),
      ]),
    );
  };
  return { ok: true, definition: restorePlaceholders(converted) as Draft };
}
