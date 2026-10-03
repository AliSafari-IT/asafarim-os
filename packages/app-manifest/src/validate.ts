import type { z } from "zod";
import { AppManifestSchema, type AppManifest, type AppManifestInput } from "./schema.ts";

export interface ManifestProblem {
  /** Field path, e.g. `roles[1].grants[0]` (empty for the whole manifest). */
  path: string;
  message: string;
}

export type ManifestValidation = { ok: true; manifest: AppManifest } | { ok: false; problems: ManifestProblem[] };

/** `["roles", 1, "grants", 0]` → `roles[1].grants[0]`. */
export function formatPath(path: readonly PropertyKey[]): string {
  return path.map((seg, i) => (typeof seg === "number" ? `[${seg}]` : `${i === 0 ? "" : "."}${String(seg)}`)).join("");
}

function toProblems(error: z.ZodError): ManifestProblem[] {
  return error.issues.map((i) => ({ path: formatPath(i.path), message: i.message }));
}

/** Validate anything (parsed JSON, a module's default export) as an app manifest. */
export function validateManifest(input: unknown): ManifestValidation {
  const parsed = AppManifestSchema.safeParse(input);
  return parsed.success ? { ok: true, manifest: parsed.data } : { ok: false, problems: toProblems(parsed.error) };
}

/** Thrown by `defineApp` for an invalid manifest. */
export class ManifestError extends Error {
  readonly problems: ManifestProblem[];

  constructor(problems: ManifestProblem[]) {
    super(`Invalid app manifest:\n${formatProblems(problems)}`);
    this.name = "ManifestError";
    this.problems = problems;
  }
}

/** One problem per line: `  - roles[1].grants[0]: message`. */
export function formatProblems(problems: readonly ManifestProblem[]): string {
  return problems.map((p) => `  - ${p.path || "(manifest)"}: ${p.message}`).join("\n");
}

/**
 * What an app's `platform.app.ts` default-exports. Validates eagerly, so an
 * invalid manifest fails the app's typecheck-time import, not just CI.
 */
export function defineApp(manifest: AppManifestInput): AppManifest {
  const result = validateManifest(manifest);
  if (!result.ok) throw new ManifestError(result.problems);
  return result.manifest;
}
