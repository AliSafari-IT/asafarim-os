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
