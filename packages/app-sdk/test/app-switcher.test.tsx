import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LauncherTile } from "../src/index.ts";
import {
  AppSwitcher,
  clampShift,
  MORE_FROM_ASAFARIM,
  moveIndex,
  OS_HOME,
  switcherMove,
  switcherTiles,
  tileColor,
} from "../src/react.tsx";

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

  it("variant icon: the grid alone in a round button, no glyph or name, the same accessible name", () => {
    const html = renderToStaticMarkup(
      <AppSwitcher apps={[tile("docs")]} current="admin" fallback={{ name: "Admin", glyph: "AD" }} variant="icon" />,
    );
    expect(html).toContain('class="asafarim-switcher asafarim-switcher--icon"');
    expect(html).toContain('aria-label="Admin: switch app"');
    expect(html).toContain('title="Switch app"');
    expect(html).not.toContain(">AD</span>");
    expect(html).not.toContain("<span>Admin</span>");
    expect(html).toContain("asafarim-switcher__grid");
  });

  it("the default (full) variant keeps the glyph and the name", () => {
    const html = renderToStaticMarkup(
      <AppSwitcher apps={[]} current="admin" fallback={{ name: "Admin", glyph: "AD" }} />,
    );
    expect(html).toContain('class="asafarim-switcher"');
    expect(html).toContain(">AD</span>");
    expect(html).toContain("<span>Admin</span>");
    expect(html).not.toContain("title=");
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

  it("lists ASafariM's other products after the apps, in English: Breinhap and IGS-Pharma", () => {
    expect(MORE_FROM_ASAFARIM.map((m) => m.href)).toEqual([
      "https://breinhap.asafarim.site/en/",
      "https://igs.asafarim.site/en/",
    ]);
    for (const m of MORE_FROM_ASAFARIM) expect(m.glyph).toMatch(/^[A-Z]{2}$/);
  });
});

describe("clampShift: an open list stays inside the viewport", () => {
  it("doesn't move a list that fits", () => {
    expect(clampShift(100, 400, 1280)).toBe(0);
  });
  it("moves a list that starts past the left edge to the right (the icon variant on a wrapped phone top bar)", () => {
    expect(clampShift(-120, 216, 375)).toBe(128);
  });
  it("moves a list that ends past the right edge to the left", () => {
    expect(clampShift(200, 400, 380)).toBe(-28);
  });
  it("a list wider than the viewport starts at the left margin", () => {
    expect(clampShift(10, 500, 375)).toBe(-2);
  });
});

describe("switcherMove: the panel's keyboard, a 3-column app grid then a plain list (#302)", () => {
  // 5 apps (two rows: 0 1 2 / 3 4), then 2 products and the home link: 8 items, grid of 5.
  const move = (key: string, at: number) => switcherMove(key, at, 8, 5);
  it("←/→ step along the grid, wrapping at both ends", () => {
    expect(move("ArrowRight", 0)).toBe(1);
    expect(move("ArrowRight", 7)).toBe(0);
    expect(move("ArrowLeft", 0)).toBe(7);
  });
  it("↓/↑ move by a row in the grid", () => {
    expect(move("ArrowDown", 1)).toBe(4);
    expect(move("ArrowUp", 4)).toBe(1);
  });
  it("↓ from the last row goes on to the list; ↑ from the list's first item comes back to the grid", () => {
    expect(move("ArrowDown", 2)).toBe(5); // no tile below 2: on to the first product
    expect(move("ArrowDown", 4)).toBe(5);
    expect(move("ArrowUp", 5)).toBe(4);
    expect(move("ArrowDown", 6)).toBe(7);
  });
  it("↑ from the top row wraps to the last item; Home/End jump; nothing focused yet starts at an end", () => {
    expect(move("ArrowUp", 0)).toBe(7);
    expect(move("Home", 6)).toBe(0);
    expect(move("End", 1)).toBe(7);
    expect(move("ArrowDown", -1)).toBe(0);
    expect(move("ArrowUp", -1)).toBe(7);
    expect(move("a", 0)).toBeUndefined();
    expect(switcherMove("ArrowDown", 0, 0, 0)).toBeUndefined();
  });
});

describe("tileColor: a tile is drawn in its brand colour, never in anything else (#302)", () => {
  it("uses a #rrggbb hex as given", () => {
    expect(tileColor("docs", "#0f766e")).toBe("#0f766e");
  });
  it("derives a stable colour from the key for a missing or invalid one: no CSS gets in", () => {
    const derived = tileColor("docs");
    expect(derived).toMatch(/^hsl\(\d{1,3} 62% 46%\)$/);
    expect(tileColor("docs")).toBe(derived);
    for (const bad of ["red", "#fff", "#0f766e;background:url(x)", "var(--x)", "#0f766e)"])
      expect(tileColor("docs", bad)).toBe(derived);
  });
  it("every product outside the OS has its own colour", () => {
    for (const m of MORE_FROM_ASAFARIM) expect(m.color).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("AppSwitcher: the face is drawn in the current app's colour", () => {
  it("full variant: the current tile's brand colour on its glyph", () => {
    const html = renderToStaticMarkup(
      <AppSwitcher
        apps={[tile("docs", { color: "#0f766e" })]}
        current="docs"
        fallback={{ name: "Docs", glyph: "DC" }}
      />,
    );
    expect(html).toContain("--t:#0f766e");
  });
});
