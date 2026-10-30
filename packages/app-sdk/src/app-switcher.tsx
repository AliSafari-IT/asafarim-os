"use client";
/**
 * The app switcher (#302): a button for the top bar that opens the OS's app launcher, a panel with the
 * apps the signed-in person can open as a grid of brand-coloured tiles, then ASafariM's products outside
 * the OS (`more`: Breinhap, IGS-Pharma) and the way home (`home`). Same data as <Launcher> (fetch the tiles
 * on the server with `platform.access.launcher(subject)` and pass them in); it only needs the browser for
 * opening and closing.
 *
 *   <AppSwitcher apps={tiles} current="docs" fallback={{ name: "Docs", glyph: "DC" }} variant="icon" />
 *
 * Each tile is the app's glyph on its brand colour (the manifest's `ui.color`, carried by the launcher; a
 * colour that isn't "#rrggbb" is never used: a stable one derived from the key takes its place), its name
 * below. The current app has a ring and an "Open" dot. The tile hovered or focused shows its description
 * on the panel's caption line (and as its `title`).
 *
 * Keyboard: Enter/Space/ArrowDown open it on the first app, ArrowUp on the last; in the grid ←/→ move
 * along, ↑/↓ by row, then on into the products and the home link; Home/End; Escape closes and returns
 * focus to the button; Tab leaves. A click outside closes it. Every item is a plain link (middle-click and
 * "open in new tab" work). The panel is not a <nav> element (it has the navigation role), so a host's
 * `nav a { … }` rules can't reach its items, and its selectors outrank a host's link styles.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { LauncherTile } from "./launcher.ts";
import { safeHref } from "./safe-href.ts";

/*
 * The SDK compiles without the DOM library (most of it runs on servers), so the few browser calls this
 * component makes are typed here, structurally.
 */
interface Focusable {
  focus(): void;
}
interface Box {
  getBoundingClientRect(): { left: number; right: number };
}
interface Laid {
  offsetLeft: number;
  offsetWidth: number;
}
interface Doc {
  addEventListener(type: "pointerdown", listener: (e: { target: unknown }) => void): void;
  removeEventListener(type: "pointerdown", listener: (e: { target: unknown }) => void): void;
}
const focusOn = (el: unknown) => (el as Focusable | null | undefined)?.focus();
const browserDocument = () => (globalThis as unknown as { document?: Doc }).document;

export interface AppSwitcherProps {
  apps: readonly LauncherTile[];
  /** The app this is rendered in: its tile is the button's face and is marked current in the panel. */
  current: string;
  /** The button's face when the current app has no tile (it isn't in the list). */
  fallback: { name: string; glyph: string };
  /** The panel's accessible name. */
  label?: string;
  /** The link back to the OS homepage at the foot of the panel (default: asafarim.site); null for none. */
  home?: { href: string; label: string } | null;
  /** ASafariM's products outside the OS, after the apps (default: MORE_FROM_ASAFARIM); [] for none. */
  more?: readonly MoreLink[];
  /** "full" (default): the current app's glyph and name, then the grid. "icon": the grid alone, round. */
  variant?: "full" | "icon";
}

/** A product with its own site, not an OS app: no access check, it opens for everyone. */
export interface MoreLink {
  key: string;
  name: string;
  glyph: string;
  description: string;
  href: string;
  /** Its brand colour, "#rrggbb". */
  color?: string;
}

/**
 * ASafariM's products outside the OS, in English like the OS (the same list as @asafarim/theme's PRODUCT_LINKS,
 * which the footers use).
 */
export const MORE_FROM_ASAFARIM: readonly MoreLink[] = [
  {
    key: "breinhap",
    name: "Breinhap",
    glyph: "BH",
    description: "Study app for Flemish students (Android)",
    href: "https://breinhap.asafarim.site/en/",
    color: "#db2777",
  },
  {
    key: "igs-pharma",
    name: "IGS-Pharma",
    glyph: "IG",
    description: "Online pharmacy for Belgium, and its Android app",
    href: "https://igs.asafarim.site/en/",
    color: "#059669",
  },
];

/** Tiles per row in the panel's app grid. */
export const GRID_COLUMNS = 3;

/** The next focused index for a key in a plain list, or undefined when the key isn't a move. Wraps. */
export function moveIndex(key: string, index: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  switch (key) {
    case "ArrowDown":
      return (index + 1 + count) % count;
    case "ArrowUp":
      return index < 0 ? count - 1 : (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}

/**
 * The next focused index in the panel: the first `grid` items are the app grid (`columns` per row), the
 * rest a plain list after it (the products, the home link). In the grid ←/→ move one, ↑/↓ one row; ↓
 * from the last row goes on to the list, ↑ from the list's first item back to the grid's last. Wraps at
 * both ends. Undefined when the key isn't a move.
 */
export function switcherMove(
  key: string,
  index: number,
  count: number,
  grid: number,
  columns = GRID_COLUMNS,
): number | undefined {
  if (count <= 0) return undefined;
  const wrap = (i: number) => (i + count) % count;
  const inGrid = index >= 0 && index < grid;
  switch (key) {
    case "ArrowRight":
      return index < 0 ? 0 : wrap(index + 1);
    case "ArrowLeft":
      return index < 0 ? count - 1 : wrap(index - 1);
    case "ArrowDown":
      if (index < 0) return 0;
      if (inGrid) return index + columns < grid ? index + columns : grid < count ? grid : wrap(index + 1);
      return wrap(index + 1);
    case "ArrowUp":
      if (index < 0) return count - 1;
      if (inGrid) return index - columns >= 0 ? index - columns : count - 1;
      return index === grid && grid > 0 ? grid - 1 : wrap(index - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}

/** The tiles that can be linked to (http/https only), in core-api's order. */
export function switcherTiles(apps: readonly LauncherTile[]): LauncherTile[] {
  return apps.flatMap((a) => {
    const href = safeHref(a.href);
    return href ? [{ ...a, href }] : [];
  });
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * A tile's colour: its brand colour when it is a "#rrggbb" hex, else a stable one derived from its key
 * (so every tile has one, and nothing but a hex or our own hsl() ever reaches the style).
 */
export function tileColor(key: string, color?: string): string {
  if (color && HEX.test(color)) return color;
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return `hsl(${h} 62% 46%)`;
}

/** Room kept between an open panel and the edges of the viewport, in pixels. */
export const VIEWPORT_MARGIN = 8;

/**
 * How far to move an open panel sideways so it stays inside the viewport: right when it starts past the
 * left edge, left when it ends past the right edge, else 0. A panel wider than the room left starts at the
 * left margin.
 */
export function clampShift(left: number, right: number, viewport: number, margin = VIEWPORT_MARGIN): number {
  if (left < margin) return margin - left;
  if (right > viewport - margin) return Math.max(viewport - margin - right, margin - left);
  return 0;
}

/*
 * Every rule starts with `.asafarim-switcher .asafarim-switcher__…` (two classes, plus an element or a
 * state for the links), which outranks the usual host link rules (`.top nav a`, `header a:hover`); the
 * panel isn't a <nav>, so `nav a` rules don't match at all. Colours come from the host's tokens (--card,
 * --ink, --muted, --line, --accent) with light and dark fallbacks; a tile's colour is its own (--t).
 */
export const APP_SWITCHER_CSS = `
.asafarim-switcher{--s-bg:var(--card,#fff);--s-ink:var(--ink,#1d1b16);--s-muted:var(--muted,#6b6559);--s-line:var(--line,#e4dfd3);--s-accent:var(--accent,#7c3aed);--s-accent-ink:var(--accent-ink,#fff);--s-hover:color-mix(in srgb,var(--s-ink) 7%,transparent);position:relative;display:inline-block;font:inherit;line-height:1.3}
@media (prefers-color-scheme:dark){.asafarim-switcher{--s-bg:var(--card,#1f1c17);--s-ink:var(--ink,#f1ece2);--s-muted:var(--muted,#a39c8e);--s-line:var(--line,#37322a);--s-accent:var(--accent,#a78bfa);--s-accent-ink:var(--accent-ink,#15130f)}}
.asafarim-switcher *,.asafarim-switcher *::before,.asafarim-switcher *::after{box-sizing:border-box}
.asafarim-switcher .asafarim-switcher__button{display:inline-flex;align-items:center;gap:.5rem;margin:0;padding:.25rem .5rem .25rem .25rem;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--s-ink);font:inherit;font-weight:700;cursor:pointer;transition:border-color .15s,background-color .15s,box-shadow .2s}
.asafarim-switcher .asafarim-switcher__button:hover,.asafarim-switcher .asafarim-switcher__button[aria-expanded="true"]{border-color:var(--s-line);background:var(--s-bg);box-shadow:0 2px 10px rgb(0 0 0 / .08)}
.asafarim-switcher .asafarim-switcher__button:focus-visible{outline:2px solid var(--s-accent);outline-offset:2px}
.asafarim-switcher--icon .asafarim-switcher__button{justify-content:center;width:2.5rem;height:2.5rem;padding:0;border-color:var(--s-line);border-radius:50%}
.asafarim-switcher--icon .asafarim-switcher__button[aria-expanded="true"]{border-color:var(--s-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--s-accent) 25%,transparent)}
.asafarim-switcher .asafarim-switcher__grid-icon{width:1.125rem;height:1.125rem;color:var(--s-muted);transition:transform .3s cubic-bezier(.2,.8,.2,1),color .15s}
.asafarim-switcher .asafarim-switcher__grid-icon circle{transform-box:fill-box;transform-origin:center;transition:transform .25s cubic-bezier(.2,.8,.2,1)}
.asafarim-switcher .asafarim-switcher__button:hover .asafarim-switcher__grid-icon,.asafarim-switcher .asafarim-switcher__button[aria-expanded="true"] .asafarim-switcher__grid-icon{color:var(--s-accent)}
.asafarim-switcher .asafarim-switcher__button:hover .asafarim-switcher__grid-icon circle{animation:asafarim-dot 1.1s ease-in-out infinite;animation-delay:calc(var(--d) * 70ms)}
.asafarim-switcher .asafarim-switcher__button[aria-expanded="true"] .asafarim-switcher__grid-icon{transform:rotate(45deg)}
.asafarim-switcher .asafarim-switcher__button[aria-expanded="true"] .asafarim-switcher__grid-icon circle{transform:scale(1.15)}
.asafarim-switcher .asafarim-switcher__face{display:inline-grid;place-items:center;flex:none;width:2rem;height:2rem;border-radius:9px;background:linear-gradient(140deg,color-mix(in srgb,var(--t) 82%,#fff),var(--t) 55%,color-mix(in srgb,var(--t) 75%,#000));color:#fff;font-size:.75rem;font-weight:800;letter-spacing:.02em;box-shadow:inset 0 1px 0 rgb(255 255 255 / .3),0 2px 6px color-mix(in srgb,var(--t) 35%,transparent)}
.asafarim-switcher .asafarim-switcher__panel{position:absolute;z-index:60;top:calc(100% + 10px);left:0;display:flex;flex-direction:column;width:min(21.5rem,calc(100vw - 1rem));max-height:min(80vh,34rem);margin:0;padding:.75rem;border:1px solid color-mix(in srgb,var(--s-line) 80%,transparent);border-radius:18px;background:color-mix(in srgb,var(--s-bg) 94%,transparent);color:var(--s-ink);box-shadow:0 1px 0 rgb(255 255 255 / .06) inset,0 24px 60px -12px rgb(0 0 0 / .45),0 8px 20px -8px rgb(0 0 0 / .3);-webkit-backdrop-filter:blur(18px) saturate(1.4);backdrop-filter:blur(18px) saturate(1.4);text-align:left;transform-origin:top left;animation:asafarim-panel .22s cubic-bezier(.2,.9,.25,1)}
.asafarim-switcher--icon .asafarim-switcher__panel{left:auto;right:0;transform-origin:top right}
.asafarim-switcher .asafarim-switcher__head{display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.125rem .25rem .625rem}
.asafarim-switcher .asafarim-switcher__title{margin:0;color:var(--s-ink);font-size:.95rem;font-weight:700;letter-spacing:-.01em}
.asafarim-switcher .asafarim-switcher__body{overflow:auto;margin:0 -.25rem;padding:0 .25rem;scrollbar-width:thin}
.asafarim-switcher .asafarim-switcher__apps,.asafarim-switcher .asafarim-switcher__more{display:grid;margin:0;padding:0;list-style:none}
.asafarim-switcher .asafarim-switcher__apps{grid-template-columns:repeat(${GRID_COLUMNS},minmax(0,1fr));gap:.25rem}
.asafarim-switcher .asafarim-switcher__apps>li,.asafarim-switcher .asafarim-switcher__more>li{margin:0;padding:0;animation:asafarim-rise .32s cubic-bezier(.2,.8,.2,1) both;animation-delay:calc(var(--i,0) * 28ms + 40ms)}
.asafarim-switcher a.asafarim-switcher__tile{position:relative;display:flex;flex-direction:column;align-items:center;gap:.4rem;width:100%;margin:0;padding:.75rem .25rem .625rem;border:0;border-radius:14px;background:transparent;color:var(--s-ink);font-weight:500;text-align:center;text-decoration:none;transition:background-color .15s,transform .15s}
.asafarim-switcher a.asafarim-switcher__tile:hover{background:var(--s-hover);color:var(--s-ink)}
.asafarim-switcher a.asafarim-switcher__tile:focus-visible{outline:2px solid var(--s-accent);outline-offset:-2px;background:var(--s-hover)}
.asafarim-switcher a.asafarim-switcher__tile:active{transform:scale(.96)}
.asafarim-switcher .asafarim-switcher__icon{position:relative;display:grid;place-items:center;width:3rem;height:3rem;border-radius:14px;background:linear-gradient(140deg,color-mix(in srgb,var(--t) 78%,#fff),var(--t) 52%,color-mix(in srgb,var(--t) 72%,#000));color:#fff;font-size:.95rem;font-weight:800;letter-spacing:.02em;box-shadow:inset 0 1px 0 rgb(255 255 255 / .35),inset 0 -2px 6px rgb(0 0 0 / .18),0 6px 14px -4px color-mix(in srgb,var(--t) 60%,transparent);transition:transform .2s cubic-bezier(.2,.8,.2,1),box-shadow .2s}
.asafarim-switcher .asafarim-switcher__mark{position:relative;z-index:1;width:58%;height:58%;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 1px 1px rgb(0 0 0 / .25))}
.asafarim-switcher .asafarim-switcher__face .asafarim-switcher__mark{width:62%;height:62%}
.asafarim-switcher .asafarim-switcher__icon::after{content:"";position:absolute;inset:0;border-radius:inherit;background:radial-gradient(120% 70% at 30% 0%,rgb(255 255 255 / .35),transparent 60%);pointer-events:none}
.asafarim-switcher a.asafarim-switcher__tile:hover .asafarim-switcher__icon,.asafarim-switcher a.asafarim-switcher__tile:focus-visible .asafarim-switcher__icon{transform:translateY(-2px);box-shadow:inset 0 1px 0 rgb(255 255 255 / .35),inset 0 -2px 6px rgb(0 0 0 / .18),0 10px 20px -6px color-mix(in srgb,var(--t) 70%,transparent)}
.asafarim-switcher a.asafarim-switcher__tile[aria-current="page"] .asafarim-switcher__icon{box-shadow:0 0 0 2px var(--s-bg),0 0 0 4px var(--t),0 6px 14px -4px color-mix(in srgb,var(--t) 60%,transparent)}
.asafarim-switcher .asafarim-switcher__name{display:block;max-width:100%;overflow:hidden;color:var(--s-ink);font-size:.8rem;font-weight:600;white-space:nowrap;text-overflow:ellipsis}
.asafarim-switcher .asafarim-switcher__open{display:inline-flex;align-items:center;gap:.3rem;color:var(--s-muted);font-size:.68rem;font-weight:600;letter-spacing:.02em}
.asafarim-switcher .asafarim-switcher__open::before{content:"";width:.4rem;height:.4rem;border-radius:50%;background:#22c55e;box-shadow:0 0 0 2px color-mix(in srgb,#22c55e 25%,transparent)}
.asafarim-switcher .asafarim-switcher__empty,.asafarim-switcher .asafarim-switcher__note{margin:.25rem .25rem .5rem;color:var(--s-muted);font-size:.8rem;line-height:1.45}
.asafarim-switcher .asafarim-switcher__section{display:flex;align-items:center;gap:.5rem;margin:.75rem .25rem .375rem;color:var(--s-muted);font-size:.68rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.asafarim-switcher .asafarim-switcher__section::after{content:"";flex:1;height:1px;background:var(--s-line)}
.asafarim-switcher .asafarim-switcher__more{grid-template-columns:repeat(2,minmax(0,1fr));gap:.25rem}
.asafarim-switcher a.asafarim-switcher__product{display:flex;align-items:center;gap:.45rem;width:100%;margin:0;padding:.375rem .375rem .375rem .3rem;border:0;border-radius:12px;background:transparent;color:var(--s-ink);font-weight:500;text-align:left;text-decoration:none;transition:background-color .15s}
.asafarim-switcher a.asafarim-switcher__product:hover{background:var(--s-hover);color:var(--s-ink)}
.asafarim-switcher a.asafarim-switcher__product:focus-visible{outline:2px solid var(--s-accent);outline-offset:-2px;background:var(--s-hover)}
.asafarim-switcher a.asafarim-switcher__product .asafarim-switcher__icon{flex:none;width:1.875rem;height:1.875rem;border-radius:9px;font-size:.66rem}
.asafarim-switcher a.asafarim-switcher__product .asafarim-switcher__name{flex:1;min-width:0;text-align:left}
.asafarim-switcher .asafarim-switcher__out{flex:none;width:.75rem;height:.75rem;color:var(--s-muted);transition:transform .15s,color .15s}
.asafarim-switcher a.asafarim-switcher__product:hover .asafarim-switcher__out{color:var(--s-ink);transform:translate(1px,-1px)}
.asafarim-switcher .asafarim-switcher__foot{display:flex;align-items:center;gap:.5rem;margin:.625rem -.75rem -.75rem;padding:.5rem .75rem;border-top:1px solid var(--s-line);border-radius:0 0 18px 18px;background:color-mix(in srgb,var(--s-ink) 3%,transparent)}
.asafarim-switcher .asafarim-switcher__hint{display:-webkit-box;flex:1;min-width:0;min-height:2.6em;overflow:hidden;margin:0;color:var(--s-muted);font-size:.75rem;line-height:1.3;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2}
.asafarim-switcher a.asafarim-switcher__home{display:inline-grid;flex:none;place-items:center;width:2rem;height:2rem;margin:0;padding:0;border:1px solid var(--s-line);border-radius:50%;background:transparent;color:var(--s-ink);text-decoration:none;transition:background-color .15s,border-color .15s,color .15s}
.asafarim-switcher a.asafarim-switcher__home:hover{border-color:var(--s-accent);background:var(--s-hover);color:var(--s-accent)}
.asafarim-switcher a.asafarim-switcher__home:focus-visible{outline:2px solid var(--s-accent);outline-offset:2px}
.asafarim-switcher a.asafarim-switcher__home svg{width:.9rem;height:.9rem}
@keyframes asafarim-panel{from{opacity:0;transform:translateY(-8px) scale(.96)}to{opacity:1;transform:none}}
@keyframes asafarim-rise{from{opacity:0;transform:translateY(6px) scale(.97)}to{opacity:1;transform:none}}
@keyframes asafarim-dot{0%,100%{transform:scale(1)}50%{transform:scale(.55)}}
@media (prefers-reduced-motion:reduce){.asafarim-switcher *,.asafarim-switcher *::before,.asafarim-switcher *::after{animation:none!important;transition:none!important}}
`;

/** The way back to the OS homepage, at the foot of the panel. */
export const OS_HOME = { href: "https://asafarim.site/", label: "ASafariM OS home" } as const;

/** The 3×3 apps-grid icon (its dots ripple on hover). */
function GridIcon() {
  const dots = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      dots.push(
        <circle
          key={`${r}${c}`}
          cx={2 + c * 4}
          cy={2 + r * 4}
          r={1.4}
          fill="currentColor"
          style={{ "--d": r + c } as object}
        />,
      );
  return (
    <svg className="asafarim-switcher__grid-icon" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      {dots}
    </svg>
  );
}

/** A house: the OS home link's glyph. */
export function HomeIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M3 9.2 10 3l7 6.2V17a1 1 0 0 1-1 1h-3.5v-5h-5v5H4a1 1 0 0 1-1-1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "Opens its own site": an arrow out of a corner. */
function OutIcon() {
  return (
    <svg className="asafarim-switcher__out" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M6 3.5h6.5V10M12.5 3.5 4 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/*
 * The OS apps' and products' icons (#302): white line drawings on the tile's brand colour, 24×24, drawn
 * for this switcher. An app without one shows its glyph (the manifest's letters) instead.
 */
const ICON_PATHS: Record<string, readonly string[]> = {
  // Three sliders, the console that tunes the OS: the same mark as Admin's logo and favicon. A path that
  // starts with "F" is filled (the knobs), the rest are drawn as lines.
  admin: [
    "M5 7h14M5 12h14M5 17h14",
    "FM7 7a2.3 2.3 0 1 0 4.6 0 2.3 2.3 0 1 0-4.6 0",
    "FM12.7 12a2.3 2.3 0 1 0 4.6 0 2.3 2.3 0 1 0-4.6 0",
    "FM8.6 17a2.3 2.3 0 1 0 4.6 0 2.3 2.3 0 1 0-4.6 0",
  ],
  // A page with a folded corner and lines of text.
  docs: ["M7 3.5h6.5L18 8v12.5H7z", "M13.5 3.5V8H18", "M9.5 12h6M9.5 15h6M9.5 18h4"],
  // Three steps joined by a path: a trigger, a decision, an outcome.
  flow: [
    "M4 5.5a2 2 0 1 0 4 0 2 2 0 1 0-4 0",
    "M16 5.5a2 2 0 1 0 4 0 2 2 0 1 0-4 0",
    "M10 18.5a2 2 0 1 0 4 0 2 2 0 1 0-4 0",
    "M8 5.5h8M18 7.5v2.5a3 3 0 0 1-3 3h-3v3.5",
  ],
  // A note with a pencil writing on it.
  notes: ["M5 4.5h10v15H5z", "M7.5 8.5h5M7.5 11.5h3", "M19.5 9 13 15.5l-1 3 3-1L21.5 11z"],
  // A lightbulb: studying, an idea at a time.
  breinhap: [
    "M12 3.5a5.5 5.5 0 0 0-3.3 9.9c.7.5 1.1 1.3 1.1 2.1v.5h4.4v-.5c0-.8.4-1.6 1.1-2.1A5.5 5.5 0 0 0 12 3.5z",
    "M9.8 18.5h4.4M10.6 21h2.8",
  ],
  // A capsule and a pharmacy cross.
  "igs-pharma": [
    "M4.6 13.4a3.6 3.6 0 0 1 0-5.1l3.7-3.7a3.6 3.6 0 0 1 5.1 5.1l-3.7 3.7a3.6 3.6 0 0 1-5.1 0z",
    "M6.5 6.5l5 5",
    "M17 13v7M13.5 16.5h7",
  ],
};

/** Whether the switcher draws an icon for this key (else the glyph's letters). */
export const hasAppIcon = (key: string): boolean => Object.hasOwn(ICON_PATHS, key);

/** The tile's mark: the app's icon when there is one, else its glyph. */
function Mark({ appKey, glyph }: { appKey: string; glyph: string }) {
  const paths = Object.hasOwn(ICON_PATHS, appKey) ? ICON_PATHS[appKey] : undefined;
  if (!paths) return <>{glyph}</>;
  return (
    <svg className="asafarim-switcher__mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {paths.map((d) =>
        d.startsWith("F") ? <path key={d} d={d.slice(1)} fill="currentColor" stroke="none" /> : <path key={d} d={d} />,
      )}
    </svg>
  );
}

const tint = (key: string, color?: string) => ({ "--t": tileColor(key, color) }) as object;

export function AppSwitcher({
  apps,
  current,
  fallback,
  label = "Your apps",
  home = OS_HOME,
  more = MORE_FROM_ASAFARIM,
  variant = "full",
}: AppSwitcherProps) {
  const tiles = switcherTiles(apps);
  const extras = more.flatMap((m) => {
    const href = safeHref(m.href);
    return href ? [{ ...m, href }] : [];
  });
  const homeHref = home ? safeHref(home.href) : undefined;
  // Keyboard order: the app grid, then the other products, then the home link.
  const count = tiles.length + extras.length + (homeHref ? 1 : 0);
  const face = tiles.find((t) => t.key === current) ?? { ...fallback, key: current, color: undefined };
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(-1);
  // The caption line: the description of the tile hovered or focused (the current app's by default).
  const [hint, setHint] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  const panelId = useId();
  const titleId = useId();

  // Move focus to the chosen item whenever it changes while open.
  useEffect(() => {
    if (open && focus >= 0) focusOn(itemRefs.current[focus]);
  }, [open, focus]);

  // A click anywhere outside closes it (without stealing focus from where the click went).
  useEffect(() => {
    const doc = browserDocument();
    if (!open || !doc) return;
    const onDown = (e: { target: unknown }) => {
      const root = rootRef.current as unknown as { contains(node: unknown): boolean } | null;
      if (!root?.contains(e.target)) setOpen(false);
    };
    doc.addEventListener("pointerdown", onDown);
    return () => doc.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Keep the open panel inside the viewport (the icon variant opens leftwards from its button, which on
  // a narrow screen, with the top bar wrapped, can sit near the left edge).
  useLayoutEffect(() => {
    // Measured from the layout (the root's box and the panel's offsets), not the panel's own box: that is
    // scaled by the opening animation, which would make the shift come out short.
    const root = rootRef.current as unknown as Box | null;
    const panel = panelRef.current as unknown as Laid | null;
    const viewport = (globalThis as { innerWidth?: number }).innerWidth;
    if (!open || !root || !panel || !viewport) return setShift(0);
    const left = root.getBoundingClientRect().left + panel.offsetLeft;
    setShift(clampShift(left, left + panel.offsetWidth, viewport));
  }, [open]);

  const openAt = (index: number) => {
    setOpen(true);
    setHint(null);
    setFocus(count ? index : -1);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    setFocus(-1);
    if (refocus) focusOn(buttonRef.current);
  };

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      // Keyboard activation opens on the first app (or closes an open panel); the native click is not wanted.
      e.preventDefault();
      if (open) close(false);
      else openAt(0);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      openAt(0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openAt(count - 1);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      close(true);
    }
  };
  const onPanelKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      close(false);
      return;
    }
    const next = switcherMove(e.key, focus, count, tiles.length);
    if (next !== undefined) {
      e.preventDefault();
      setFocus(next);
    }
  };

  const currentTile = tiles.find((t) => t.key === current);
  const caption = hint ?? currentTile?.description ?? "Choose an app to open.";
  const show = (text: string | undefined) => () => setHint(text ?? null);
  const ref = (i: number) => (el: HTMLAnchorElement | null) => {
    itemRefs.current[i] = el;
  };

  return (
    <div
      className={variant === "icon" ? "asafarim-switcher asafarim-switcher--icon" : "asafarim-switcher"}
      ref={rootRef}
      data-testid="app-switcher"
    >
      <style>{APP_SWITCHER_CSS}</style>
      <button
        ref={buttonRef}
        type="button"
        className="asafarim-switcher__button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${face.name}: switch app`}
        title={variant === "icon" ? "Switch app" : undefined}
        onClick={() => (open ? close(false) : openAt(-1))}
        onKeyDown={onButtonKey}
      >
        {variant === "icon" ? null : (
          <>
            <span className="asafarim-switcher__face" aria-hidden="true" style={tint(face.key, face.color)}>
              <Mark appKey={face.key} glyph={face.glyph} />
            </span>
            <span>{face.name}</span>
          </>
        )}
        <GridIcon />
      </button>
      {open ? (
        // Not a <nav> element (a host's `nav a` rules would reach the items); the role keeps it a landmark.
        <div
          id={panelId}
          ref={panelRef}
          role="navigation"
          aria-label={label}
          className="asafarim-switcher__panel"
          onKeyDown={onPanelKey}
          onMouseLeave={show(undefined)}
          style={shift ? { translate: `${shift}px 0` } : undefined}
        >
          <div className="asafarim-switcher__head">
            <p className="asafarim-switcher__title" id={titleId}>
              Apps
            </p>
          </div>
          <div className="asafarim-switcher__body">
            {tiles.length === 0 ? (
              <p className="asafarim-switcher__empty">No apps to show right now.</p>
            ) : (
              <ul className="asafarim-switcher__apps" aria-labelledby={titleId}>
                {tiles.map((t, i) => (
                  <li key={t.key} style={{ "--i": i } as object}>
                    <a
                      ref={ref(i)}
                      className="asafarim-switcher__tile"
                      href={t.href}
                      title={t.description || undefined}
                      aria-current={t.key === current ? "page" : undefined}
                      data-testid={`app-switcher-${t.key}`}
                      onMouseEnter={show(t.description)}
                      onFocus={show(t.description)}
                    >
                      <span className="asafarim-switcher__icon" aria-hidden="true" style={tint(t.key, t.color)}>
                        <Mark appKey={t.key} glyph={t.glyph} />
                      </span>
                      <span className="asafarim-switcher__name">{t.name}</span>
                      {t.key === current ? <span className="asafarim-switcher__open">Open</span> : null}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {tiles.length === 1 ? (
              <p className="asafarim-switcher__note" data-testid="app-switcher-note">
                More apps appear here as you get access to them.
              </p>
            ) : null}
            {extras.length ? (
              <>
                <div className="asafarim-switcher__section" data-testid="app-switcher-more">
                  More from ASafariM
                </div>
                <ul className="asafarim-switcher__more">
                  {extras.map((m, j) => {
                    const i = tiles.length + j;
                    return (
                      <li key={m.key} style={{ "--i": i } as object}>
                        <a
                          ref={ref(i)}
                          className="asafarim-switcher__product"
                          href={m.href}
                          title={m.description}
                          data-testid={`app-switcher-more-${m.key}`}
                          onMouseEnter={show(m.description)}
                          onFocus={show(m.description)}
                        >
                          <span className="asafarim-switcher__icon" aria-hidden="true" style={tint(m.key, m.color)}>
                            <Mark appKey={m.key} glyph={m.glyph} />
                          </span>
                          <span className="asafarim-switcher__name">{m.name}</span>
                          <OutIcon />
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
          </div>
          <div className="asafarim-switcher__foot">
            <p className="asafarim-switcher__hint" aria-hidden="true" data-testid="app-switcher-hint">
              {caption}
            </p>
            {homeHref && home ? (
              <a
                ref={ref(tiles.length + extras.length)}
                className="asafarim-switcher__home"
                href={homeHref}
                aria-label={home.label}
                title={home.label}
                data-testid="app-switcher-home"
                onMouseEnter={show(home.label)}
                onFocus={show(home.label)}
              >
                <HomeIcon />
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
