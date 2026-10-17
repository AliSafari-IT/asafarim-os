import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LauncherTile } from "../src/index.ts";
import { AppSwitcher, moveIndex, OS_HOME, switcherTiles } from "../src/react.tsx";

const tile = (key: string, over: Partial<LauncherTile> = {}): LauncherTile => ({
  key,
  name: key[0]!.toUpperCase() + key.slice(1),
  description: `${key} app`,
  glyph: key.slice(0, 2).toUpperCase(),
  meta: `${key}.example`,
  status: "active",
  access: "authenticated",
  order: 10,
  href: `https://${key}.example/`,
  ...over,
});

describe("AppSwitcher", () => {
  it("renders closed: a button showing the current app, the menu not in the page", () => {
    const html = renderToStaticMarkup(
      <AppSwitcher apps={[tile("docs"), tile("notes")]} current="docs" fallback={{ name: "Docs", glyph: "DC" }} />,
    );
    expect(html).toContain('aria-label="Docs: switch app"');
    expect(html).toContain('aria-expanded="false"');
    // A disclosure of plain links, not an ARIA menu: no aria-haspopup.
    expect(html).not.toContain("aria-haspopup");
    expect(html).toContain(">DO</span>");
    expect(html).not.toContain("app-switcher-notes");
  });

  it("shows the fallback face when the current app has no tile (for example, core-api is down)", () => {
    const html = renderToStaticMarkup(
      <AppSwitcher apps={[]} current="docs" fallback={{ name: "Docs", glyph: "DC" }} />,
    );
    expect(html).toContain('aria-label="Docs: switch app"');
    expect(html).toContain(">DC</span>");
  });
});

describe("switcherTiles", () => {
  it("keeps http(s) apps in core-api's order and drops any other link", () => {
    const tiles = switcherTiles([
      tile("docs"),
      tile("evil", { href: "javascript:alert(1)" }),
      tile("notes", { href: "http://notes.localhost:8080" }),
      tile("bad", { href: "not a url" }),
    ]);
    expect(tiles.map((t) => t.key)).toEqual(["docs", "notes"]);
    expect(tiles[1]!.href).toBe("http://notes.localhost:8080/");
  });
});

describe("moveIndex: keyboard moves through the list, wrapping", () => {
  it("ArrowDown and ArrowUp wrap at both ends; from nothing focused they go to the first and last", () => {
    expect(moveIndex("ArrowDown", 0, 3)).toBe(1);
    expect(moveIndex("ArrowDown", 2, 3)).toBe(0);
    expect(moveIndex("ArrowUp", 0, 3)).toBe(2);
    expect(moveIndex("ArrowDown", -1, 3)).toBe(0);
    expect(moveIndex("ArrowUp", -1, 3)).toBe(2);
  });

  it("Home and End jump; other keys and an empty list are not moves", () => {
    expect(moveIndex("Home", 2, 3)).toBe(0);
    expect(moveIndex("End", 0, 3)).toBe(2);
    expect(moveIndex("a", 0, 3)).toBeUndefined();
    expect(moveIndex("ArrowDown", 0, 0)).toBeUndefined();
  });
});

describe("AppSwitcher: the way home and the single-app note", () => {
  it("exports the OS home link and the grid icon; no chevron any more", () => {
    const html = renderToStaticMarkup(
      <AppSwitcher apps={[tile("docs")]} current="docs" fallback={{ name: "Docs", glyph: "DC" }} />,
    );
    expect(html).toContain("asafarim-switcher__grid");
    expect(OS_HOME.href).toBe("https://asafarim.site/");
  });
});
