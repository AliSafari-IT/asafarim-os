/**
 * Writes schema/app-manifest.schema.json from the Zod schema. The file is
 * committed (it ships in the package); a unit test fails when it's stale.
 *
 *   pnpm --filter @asafarim/app-manifest schema
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { appManifestJsonSchema } from "../src/schema.ts";

export const SCHEMA_FILE = path.resolve(import.meta.dirname, "..", "schema", "app-manifest.schema.json");

export function renderSchema(): string {
  return `${JSON.stringify(appManifestJsonSchema(), null, 2)}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  writeFileSync(SCHEMA_FILE, renderSchema());
  console.log(`wrote ${path.relative(process.cwd(), SCHEMA_FILE)}`);
}
