import { describe, expect, it } from "vitest";
import { appHref, launcherFor, type LauncherApp } from "../src/launcher.ts";

function app(
  id: string,
  state: string,
  launcher?: { access: "public" | "authenticated"; order?: number },
  domains?: { primary: string },
): LauncherApp {
  return {
    id,
    state,
    manifest: {
      id,
      name: id.toUpperCase(),
      domains,
      ui: {
        glyph: id.slice(0, 2).toUpperCase(),
        color: "#000000",
        nav: [],
        status: "active",
        ...(launcher
          ? {
              launcher: {
                description: `${id} app`,
                meta: `${id}.example`,
                access: launcher.access,
                order: launcher.order ?? 10,
              },
            }
          : {}),
      },
    } as LauncherApp["manifest"],
  };
}
const T = { urlTemplate: "http://{id}.localhost:8080" };

describe("the launcher", () => {
  it("lists an ACTIVE app the person holds a role in", () => {
    const tiles = launcherFor([app("notes", "active", { access: "authenticated" })], new Set(["notes"]), T);
    expect(tiles).toMatchObject([{ key: "notes", name: "NOTES", glyph: "NO", href: "http://notes.localhost:8080" }]);
  });

  it("hides an app the person holds no role in", () => {
    expect(launcherFor([app("notes", "active", { access: "authenticated" })], new Set(), T)).toEqual([]);
  });

  it("shows a public app to everyone, role or not", () => {
    expect(launcherFor([app("docs", "active", { access: "public" })], new Set(), T)).toHaveLength(1);
  });

  it("never lists an app that isn't active, even a public one or one the person holds a role in", () => {
    const apps = ["installed", "inactive", "removed"].flatMap((s) => [
      app(`a-${s}`, s, { access: "authenticated" }),
      app(`p-${s}`, s, { access: "public" }),
    ]);
    expect(launcherFor(apps, new Set(apps.map((a) => a.id)), T)).toEqual([]);
  });

  it("an app with no launcher block (and the built-in core) isn't listed", () => {
    expect(launcherFor([app("quiet", "active"), app("core", "active")], new Set(["quiet", "core"]), T)).toEqual([]);
  });

  it("orders by `order`, then id, like the generated registry", () => {
    const apps = [
      app("zeta", "active", { access: "public", order: 5 }),
      app("beta", "active", { access: "public", order: 10 }),
      app("alpha", "active", { access: "public", order: 10 }),
    ];
    expect(launcherFor(apps, new Set(), T).map((t) => t.key)).toEqual(["zeta", "alpha", "beta"]);
  });

  it("opens an app at its primary domain without a template, and omits one it can't place", () => {
    expect(appHref(app("notes", "active", { access: "public" }, { primary: "notes.asafarim.site" }), {})).toBe(
      "https://notes.asafarim.site",
    );
    const noHome = app("lost", "active", { access: "public" });
    expect(launcherFor([noHome], new Set(), {})).toEqual([]);
  });
});
