"use client";
/**
 * The app switcher: a button for the top bar that opens the list of OS apps the signed-in person
 * can open, and goes to one when it is chosen. Same data as <Launcher> (fetch the tiles on the
 * server with `platform.access.launcher(subject)` and pass them in); it only needs the browser for
 * opening and closing.
 *
 *   <AppSwitcher apps={tiles} current="docs" />
 *
 * `variant="icon"` is a round grid-icon button with no glyph or name, for a top bar whose brand is shown
 * elsewhere (Admin, next to its account menu); its list opens to the left, under the button.
 *
 * After the apps come ASafariM's products outside the OS (`more`: Breinhap, IGS-Pharma), then a link back to the
 * OS homepage (`home`). Opening animates, and the grid icon's
 * dots ripple on hover; with "reduce motion" nothing moves.
 *
 * Keyboard: Enter/Space/ArrowDown open it on the first app, ArrowUp on the last; ArrowUp/Down,
 * Home/End move; Escape closes and returns focus to the button; Tab leaves. A click outside closes
 * it. Every item is a plain link, so middle-click and "open in new tab" work. It uses the host's
 * design tokens like <Launcher>.
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
interface Doc {
  addEventListener(type: "pointerdown", listener: (e: { target: unknown }) => void): void;
  removeEventListener(type: "pointerdown", listener: (e: { target: unknown }) => void): void;
}
const focusOn = (el: unknown) => (el as Focusable | null | undefined)?.focus();
const browserDocument = () => (globalThis as unknown as { document?: Doc }).document;

export interface AppSwitcherProps {
  apps: readonly LauncherTile[];
  /** The app this is rendered in: its tile is the button's face and is marked current in the list. */
  current: string;
  /** The button's face when the current app has no tile (it isn't in the list). */
  fallback: { name: string; glyph: string };
  /** The menu's accessible name. */
  label?: string;
  /** The link back to the OS homepage at the foot of the list (default: asafarim.site); null for none. */
  home?: { href: string; label: string } | null;
  /** ASafariM's products outside the OS, listed after the apps (default: MORE_FROM_ASAFARIM); [] for none. */
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
  },
  {
    key: "igs-pharma",
    name: "IGS-Pharma",
    glyph: "IG",
    description: "Online pharmacy for Belgium, and its Android app",
    href: "https://igs.asafarim.site/en/",
  },
];

/** The next focused index for a key, or undefined when the key isn't a move. Wraps at both ends. */
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

/** Room kept between an open list and the edges of the viewport, in pixels. */
export const VIEWPORT_MARGIN = 8;

/**
 * How far to move an open list sideways so it stays inside the viewport: right when it starts past the
 * left edge, left when it ends past the right edge, else 0. A list wider than the room left starts at the
 * left margin.
 */
export function clampShift(left: number, right: number, viewport: number, margin = VIEWPORT_MARGIN): number {
  if (left < margin) return margin - left;
  if (right > viewport - margin) return Math.max(viewport - margin - right, margin - left);
  return 0;
}

/** The tiles that can be linked to (http/https only), in core-api's order. */
export function switcherTiles(apps: readonly LauncherTile[]): LauncherTile[] {
  return apps.flatMap((a) => {
    const href = safeHref(a.href);
    return href ? [{ ...a, href }] : [];
  });
}

export const APP_SWITCHER_CSS = `
.asafarim-switcher{--s-bg:var(--card,#fff);--s-ink:var(--ink,#1d1b16);--s-muted:var(--muted,#6b6559);--s-line:var(--line,#e4dfd3);--s-accent:var(--accent,#7c3aed);--s-accent-ink:var(--accent-ink,#fff);position:relative;display:inline-block}
@media (prefers-color-scheme:dark){.asafarim-switcher{--s-bg:var(--card,#1f1c17);--s-ink:var(--ink,#f1ece2);--s-muted:var(--muted,#a39c8e);--s-line:var(--line,#37322a);--s-accent:var(--accent,#a78bfa);--s-accent-ink:var(--accent-ink,#15130f)}}
.asafarim-switcher__button{display:inline-flex;align-items:center;gap:.5rem;padding:.25rem .5rem .25rem .25rem;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--s-ink);font:inherit;font-weight:700;cursor:pointer;transition:border-color .15s,background-color .15s,box-shadow .2s}
.asafarim-switcher__button:hover,.asafarim-switcher__button[aria-expanded="true"]{border-color:var(--s-line);background:var(--s-bg);box-shadow:0 2px 10px rgb(0 0 0 / .08)}
.asafarim-switcher__button:focus-visible,.asafarim-switcher__item:focus-visible{outline:2px solid var(--s-accent);outline-offset:2px}
.asafarim-switcher__grid{width:1rem;height:1rem;color:var(--s-muted);transition:transform .25s cubic-bezier(.2,.8,.2,1),color .15s}
.asafarim-switcher__grid circle{transform-box:fill-box;transform-origin:center}
.asafarim-switcher__button:hover .asafarim-switcher__grid{color:var(--s-accent)}
.asafarim-switcher__button:hover .asafarim-switcher__grid circle{animation:asafarim-dot 1.1s ease-in-out infinite;animation-delay:calc(var(--d) * 70ms)}
.asafarim-switcher__button[aria-expanded="true"] .asafarim-switcher__grid{color:var(--s-accent);transform:rotate(45deg)}
.asafarim-switcher__glyph{display:inline-grid;place-items:center;flex:none;width:2rem;height:2rem;border-radius:8px;background:linear-gradient(135deg,var(--s-accent),color-mix(in srgb,var(--s-accent) 65%,#000));color:var(--s-accent-ink);font-size:.75rem;font-weight:700;box-shadow:inset 0 1px 0 rgb(255 255 255 / .25)}
.asafarim-switcher--icon .asafarim-switcher__button{justify-content:center;width:2.5rem;height:2.5rem;padding:0;border-color:var(--s-line);border-radius:50%}
.asafarim-switcher--icon .asafarim-switcher__grid{width:1.125rem;height:1.125rem}
.asafarim-switcher__menu{position:absolute;z-index:50;top:calc(100% + 6px);left:0;width:max-content;min-width:16rem;max-width:min(22rem,calc(100vw - 2rem));max-height:min(70vh,28rem);overflow:auto;margin:0;padding:.375rem;border:1px solid var(--s-line);border-radius:12px;background:var(--s-bg);box-shadow:0 12px 32px rgb(0 0 0 / .25);transform-origin:top left;animation:asafarim-pop .18s cubic-bezier(.2,.8,.2,1)}
.asafarim-switcher__list{margin:0;padding:0;list-style:none}
.asafarim-switcher__list>li,.asafarim-switcher__foot{animation:asafarim-rise .22s cubic-bezier(.2,.8,.2,1) both;animation-delay:calc(var(--i,0) * 35ms)}
.asafarim-switcher__empty{margin:0;padding:.5rem;color:var(--s-muted);font-size:.85rem}
.asafarim-switcher__note{margin:.25rem .5rem .375rem;color:var(--s-muted);font-size:.8rem;line-height:1.4}
.asafarim-switcher__heading{padding:.375rem .5rem .25rem;color:var(--s-muted);font-size:.75rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.asafarim-switcher__item{display:flex;align-items:flex-start;gap:.625rem;padding:.5rem;border-radius:8px;color:var(--s-ink);text-decoration:none;transition:background-color .12s,transform .12s}
.asafarim-switcher__item:hover{background:color-mix(in srgb,var(--s-accent) 12%,transparent);transform:translateX(2px)}
.asafarim-switcher__item[aria-current="page"]{background:color-mix(in srgb,var(--s-accent) 18%,transparent)}
.asafarim-switcher__foot{margin-top:.25rem;padding-top:.25rem;border-top:1px solid var(--s-line)}
.asafarim-switcher__home{align-items:center}
.asafarim-switcher__home .asafarim-switcher__glyph{background:transparent;color:var(--s-accent);border:1px solid var(--s-line);box-shadow:none}
.asafarim-switcher__home svg{width:1.1rem;height:1.1rem}
.asafarim-switcher__text{display:grid;min-width:0}
.asafarim-switcher__name{font-weight:600}
.asafarim-switcher__desc{display:-webkit-box;overflow:hidden;color:var(--s-muted);font-size:.8rem;line-height:1.35;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2}
.asafarim-switcher__check{align-self:center;margin-left:auto;color:var(--s-accent);font-size:.8rem;font-weight:700}
.asafarim-switcher--icon .asafarim-switcher__menu{left:auto;right:0;transform-origin:top right}
@keyframes asafarim-pop{from{opacity:0;transform:translateY(-6px) scale(.97)}to{opacity:1;transform:none}}
@keyframes asafarim-rise{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes asafarim-dot{0%,100%{transform:scale(1)}50%{transform:scale(.55)}}
@media (prefers-reduced-motion:reduce){.asafarim-switcher *,.asafarim-switcher *::before{animation:none!important;transition:none!important}}
`;

/** The way back to the OS homepage, at the foot of the list. */
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
    <svg className="asafarim-switcher__grid" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
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
  // Keyboard order: the apps, then the other products, then the home link.
  const count = tiles.length + extras.length + (homeHref ? 1 : 0);
  const face = tiles.find((t) => t.key === current) ?? { ...fallback, key: current };
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const menuRef = useRef<HTMLElement>(null);
  const [shift, setShift] = useState(0);
  const menuId = useId();

  // Keep the open list inside the viewport. The icon variant opens leftwards from its button, which on
  // a narrow screen, with the top bar wrapped, can sit near the left edge.
  useLayoutEffect(() => {
    const box = menuRef.current as unknown as Box | null;
    const viewport = (globalThis as { innerWidth?: number }).innerWidth;
    if (!open || !box || !viewport) return setShift(0);
    const { left, right } = box.getBoundingClientRect();
    setShift(clampShift(left, right, viewport));
  }, [open]);

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

  const openAt = (index: number) => {
    setOpen(true);
    setFocus(count ? index : -1);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    setFocus(-1);
    if (refocus) focusOn(buttonRef.current);
  };

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      // Keyboard activation opens on the first app (or closes an open list); the native click is not wanted.
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
  const onMenuKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      close(false);
      return;
    }
    const next = moveIndex(e.key, focus, count);
    if (next !== undefined) {
      e.preventDefault();
      setFocus(next);
    }
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
        aria-controls={menuId}
        aria-label={`${face.name}: switch app`}
        title={variant === "icon" ? "Switch app" : undefined}
        onClick={() => (open ? close(false) : openAt(-1))}
        onKeyDown={onButtonKey}
      >
        {variant === "icon" ? null : (
          <>
            <span className="asafarim-switcher__glyph" aria-hidden="true">
              {face.glyph}
            </span>
            <span>{face.name}</span>
          </>
        )}
        <GridIcon />
      </button>
      {open ? (
        <nav
          id={menuId}
          ref={menuRef}
          className="asafarim-switcher__menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          style={shift ? { translate: `${shift}px 0` } : undefined}
        >
          <div className="asafarim-switcher__heading">{label}</div>
          {tiles.length === 0 ? (
            <p className="asafarim-switcher__empty">No apps to show right now.</p>
          ) : (
            <ul className="asafarim-switcher__list">
              {tiles.map((t, i) => (
                <li key={t.key} style={{ "--i": i } as object}>
                  <a
                    ref={(el) => {
                      itemRefs.current[i] = el;
                    }}
                    className="asafarim-switcher__item"
                    href={t.href}
                    aria-current={t.key === current ? "page" : undefined}
                    data-testid={`app-switcher-${t.key}`}
                  >
                    <span className="asafarim-switcher__glyph" aria-hidden="true">
                      {t.glyph}
                    </span>
                    <span className="asafarim-switcher__text">
                      <span className="asafarim-switcher__name">{t.name}</span>
                      {t.description ? <span className="asafarim-switcher__desc">{t.description}</span> : null}
                    </span>
                    {t.key === current ? (
                      <span className="asafarim-switcher__check" aria-hidden="true">
                        ✓
                      </span>
                    ) : null}
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
              <div className="asafarim-switcher__heading" data-testid="app-switcher-more">
                More from ASafariM
              </div>
              <ul className="asafarim-switcher__list">
                {extras.map((m, j) => {
                  const i = tiles.length + j;
                  return (
                    <li key={m.key} style={{ "--i": i } as object}>
                      <a
                        ref={(el) => {
                          itemRefs.current[i] = el;
                        }}
                        className="asafarim-switcher__item"
                        href={m.href}
                        data-testid={`app-switcher-more-${m.key}`}
                      >
                        <span className="asafarim-switcher__glyph" aria-hidden="true">
                          {m.glyph}
                        </span>
                        <span className="asafarim-switcher__text">
                          <span className="asafarim-switcher__name">{m.name}</span>
                          <span className="asafarim-switcher__desc">{m.description}</span>
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
          {homeHref && home ? (
            <div className="asafarim-switcher__foot" style={{ "--i": tiles.length + extras.length } as object}>
              <a
                ref={(el) => {
                  itemRefs.current[tiles.length + extras.length] = el;
                }}
                className="asafarim-switcher__item asafarim-switcher__home"
                href={homeHref}
                data-testid="app-switcher-home"
              >
                <span className="asafarim-switcher__glyph" aria-hidden="true">
                  <HomeIcon />
                </span>
                <span className="asafarim-switcher__name">{home.label}</span>
              </a>
            </div>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
