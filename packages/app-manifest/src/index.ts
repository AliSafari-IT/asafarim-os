import type { AppManifest } from "./schema.ts";
export {
  AppManifestSchema,
  HTTP_METHODS,
  RESERVED_APP_IDS,
  appManifestJsonSchema,
  type AppManifest,
  type AppManifestInput,
} from "./schema.ts";
export {
  ManifestError,
  defineApp,
  formatPath,
  formatProblems,
  validateManifest,
  type ManifestProblem,
  type ManifestValidation,
} from "./validate.ts";

/** Where an app serves its manifest at runtime. */
export const WELL_KNOWN_MANIFEST_PATH = "/.well-known/asafarim-app.json";
/** The compiled manifest next to an app's platform.app.ts. */
export const MANIFEST_JSON_FILE = "platform.app.json";
/** The source manifest an app author writes. */
export const MANIFEST_SOURCE_FILE = "platform.app.ts";

/** The app's default host when the manifest declares no primary domain. */
export function defaultHost(appId: string, homeDomain = "asafarim.site"): string {
  return `${appId}.${homeDomain}`;
}

/** One launcher tile, as the platform's registry and the launchers consume it. */
export interface LauncherEntry {
  key: string;
  name: string;
  description: string;
  glyph: string;
  meta: string;
  status: "active" | "coming-soon";
  access: "public" | "authenticated";
  requiresAccountToUse?: boolean;
  order: number;
}

/**
 * The launcher tiles for these manifests (those with a `ui.launcher` block), by `order` then id.
 * ONE projection for both consumers: `platform sync` writes it to generated/platform/launcher-registry.json,
 * and core-api builds each person's launcher from the installed manifests with it, so names, icons and
 * order can't differ between the generated file and what people see.
 */
export function launcherEntries(manifests: readonly Pick<AppManifest, "id" | "name" | "ui">[]): LauncherEntry[] {
  return (
    manifests
      .filter((m) => m.ui?.launcher !== undefined)
      .map((m) => {
        const l = m.ui.launcher!;
        return {
          key: m.id,
          name: m.name,
          description: l.description,
          glyph: m.ui.glyph,
          meta: l.meta,
          status: m.ui.status,
          access: l.access,
          ...(l.requiresAccountToUse === undefined ? {} : { requiresAccountToUse: l.requiresAccountToUse }),
          order: l.order,
        };
      })
      // Code-unit tie-break, not localeCompare: --check compares bytes, so the
      // order must not depend on the host's collation.
      .sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  );
}
