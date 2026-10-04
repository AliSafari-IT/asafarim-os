/**
 * The launcher's data (P3.3b): the apps the signed-in person can open. core-api decides
 * (active, and the person holds a role in the app or it is public) and supplies the tile
 * (name, glyph, description) from the same projection `platform sync` uses for the generated
 * launcher registry; the SDK just asks, signed, and never invents a tile.
 */
import type { LauncherEntry } from "@asafarim/app-manifest";

/** One app the person can open: a launcher registry entry plus where to open it. */
export interface LauncherTile extends LauncherEntry {
  href: string;
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** The tiles of core-api's answer, or undefined when it isn't the contract (never cached as an answer). */
export function parseLauncher(json: unknown): LauncherTile[] | undefined {
  const apps = (json as { apps?: unknown } | null)?.apps;
  if (!Array.isArray(apps)) return undefined;
  const tiles: LauncherTile[] = [];
  for (const a of apps as Record<string, unknown>[]) {
    if (!a || !str(a.key) || !str(a.name) || !str(a.href) || !str(a.glyph) || !Number.isInteger(a.order)) {
      return undefined;
    }
    tiles.push(a as unknown as LauncherTile);
  }
  return tiles;
}
