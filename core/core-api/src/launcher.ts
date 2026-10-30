/**
 * The launcher (P3.3b): which apps a signed-in person can open. An app is listed when it is
 * ACTIVE and the person holds at least one of its roles, or it is public. Names, icons and
 * order come from the same projection `platform sync` uses for the generated launcher registry
 * (`launcherEntries`), so the two can't disagree.
 */
import { launcherEntries, type AppManifest, type LauncherEntry } from "@asafarim/app-manifest";

export interface LauncherApp {
  id: string;
  state: string;
  manifest: Pick<AppManifest, "id" | "name" | "ui" | "domains">;
}

export interface LauncherTile extends LauncherEntry {
  /** Where to open it. */
  href: string;
}

export interface LauncherOptions {
  /** Dev: `http://{id}.localhost:8080`. Without it an app opens at https://<its primary domain>. */
  urlTemplate?: string;
}

export function appHref(app: Pick<LauncherApp, "id" | "manifest">, opts: LauncherOptions): string | undefined {
  if (opts.urlTemplate) return opts.urlTemplate.replaceAll("{id}", app.id);
  const primary = app.manifest.domains?.primary;
  return primary ? `https://${primary}` : undefined;
}

/**
 * @param apps       every app core-api knows (the built-in `core` has no `ui`, so it never appears)
 * @param heldApps   the ids of the apps in which the person holds at least one (non-deprecated) role
 */
export function launcherFor(
  apps: readonly LauncherApp[],
  heldApps: ReadonlySet<string>,
  opts: LauncherOptions = {},
): LauncherTile[] {
  const open = apps.filter(
    (a) =>
      a.state === "active" &&
      a.manifest.ui?.launcher !== undefined &&
      (a.manifest.ui.launcher.access === "public" || heldApps.has(a.id)),
  );
  const byId = new Map(open.map((a) => [a.id, a]));
  const tiles: LauncherTile[] = [];
  for (const entry of launcherEntries(open.map((a) => a.manifest))) {
    const app = byId.get(entry.key)!;
    const href = appHref(app, opts);
    if (href) tiles.push({ ...entry, href });
  }
  return tiles;
}

/** The Admin console's tile key: the console marks itself current with it (`<AppSwitcher current="admin">`). */
export const ADMIN_TILE_KEY = "admin";

/**
 * The Admin console's tile, for a person who holds `core.admin`. The console is a core service, not a
 * manifest app, so it has no launcher block of its own; it goes last, after every app.
 */
export function adminTile(href: string): LauncherTile {
  return {
    key: ADMIN_TILE_KEY,
    name: "Admin",
    description: "Manage apps, roles and access across ASafariM OS.",
    glyph: "AD",
    // The console's own mark is the OS's orange (core/admin's AdminLogo).
    color: "#c2410c",
    meta: new URL(href).host,
    status: "active",
    access: "authenticated",
    order: Number.MAX_SAFE_INTEGER,
    href,
  };
}
