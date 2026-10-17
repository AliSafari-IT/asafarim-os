"use client";
/**
 * The app switcher: a button for the top bar that opens the list of OS apps the signed-in person
 * can open, and goes to one when it is chosen. Same data as <Launcher> (fetch the tiles on the
 * server with `platform.access.launcher(subject)` and pass them in); it only needs the browser for
 * opening and closing.
 *
 *   <AppSwitcher apps={tiles} current="docs" />
 *
 * Keyboard: Enter/Space/ArrowDown open it on the first app, ArrowUp on the last; ArrowUp/Down,
 * Home/End move; Escape closes and returns focus to the button; Tab leaves. A click outside closes
 * it. Every item is a plain link, so middle-click and "open in new tab" work. It uses the host's
 * design tokens like <Launcher>.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { LauncherTile } from "./launcher.ts";
import { safeHref } from "./safe-href.ts";

/*
 * The SDK compiles without the DOM library (most of it runs on servers), so the few browser calls this
 * component makes are typed here, structurally.
 */
interface Focusable {
  focus(): void;
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
}

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
.asafarim-switcher__button{display:inline-flex;align-items:center;gap:.5rem;padding:.25rem .5rem .25rem .25rem;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--s-ink);font:inherit;font-weight:700;cursor:pointer}
.asafarim-switcher__button:hover,.asafarim-switcher__button[aria-expanded="true"]{border-color:var(--s-line);background:var(--s-bg)}
.asafarim-switcher__button:focus-visible,.asafarim-switcher__item:focus-visible{outline:2px solid var(--s-accent);outline-offset:2px}
.asafarim-switcher__chevron{width:.75rem;height:.75rem;opacity:.7;transition:transform .15s}
.asafarim-switcher__button[aria-expanded="true"] .asafarim-switcher__chevron{transform:rotate(180deg)}
.asafarim-switcher__glyph{display:inline-grid;place-items:center;flex:none;width:2rem;height:2rem;border-radius:8px;background:var(--s-accent);color:var(--s-accent-ink);font-size:.75rem;font-weight:700}
.asafarim-switcher__menu{position:absolute;z-index:50;top:calc(100% + 6px);left:0;width:max-content;min-width:16rem;max-width:min(22rem,calc(100vw - 2rem));max-height:min(70vh,28rem);overflow:auto;margin:0;padding:.375rem;border:1px solid var(--s-line);border-radius:12px;background:var(--s-bg);box-shadow:0 12px 32px rgb(0 0 0 / .25)}
.asafarim-switcher__list{margin:0;padding:0;list-style:none}
.asafarim-switcher__empty{margin:0;padding:.5rem;color:var(--s-muted);font-size:.85rem}
.asafarim-switcher__heading{padding:.375rem .5rem .25rem;color:var(--s-muted);font-size:.75rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.asafarim-switcher__item{display:flex;align-items:flex-start;gap:.625rem;padding:.5rem;border-radius:8px;color:var(--s-ink);text-decoration:none}
.asafarim-switcher__item:hover{background:color-mix(in srgb,var(--s-accent) 12%,transparent)}
.asafarim-switcher__item[aria-current="page"]{background:color-mix(in srgb,var(--s-accent) 18%,transparent)}
.asafarim-switcher__text{display:grid;min-width:0}
.asafarim-switcher__name{font-weight:600}
.asafarim-switcher__desc{display:-webkit-box;overflow:hidden;color:var(--s-muted);font-size:.8rem;line-height:1.35;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2}
.asafarim-switcher__check{align-self:center;margin-left:auto;color:var(--s-accent);font-size:.8rem;font-weight:700}
@media (prefers-reduced-motion:reduce){.asafarim-switcher__chevron{transition:none}}
`;

export function AppSwitcher({ apps, current, fallback, label = "Your apps" }: AppSwitcherProps) {
  const tiles = switcherTiles(apps);
  const face = tiles.find((t) => t.key === current) ?? { ...fallback, key: current };
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const menuId = useId();

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
    setFocus(tiles.length ? index : -1);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    setFocus(-1);
    if (refocus) focusOn(buttonRef.current);
  };

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      openAt(0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openAt(tiles.length - 1);
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
    const next = moveIndex(e.key, focus, tiles.length);
    if (next !== undefined) {
      e.preventDefault();
      setFocus(next);
    }
  };

  return (
    <div className="asafarim-switcher" ref={rootRef} data-testid="app-switcher">
      <style>{APP_SWITCHER_CSS}</style>
      <button
        ref={buttonRef}
        type="button"
        className="asafarim-switcher__button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`${face.name}: switch app`}
        onClick={() => (open ? close(false) : openAt(-1))}
        onKeyDown={onButtonKey}
      >
        <span className="asafarim-switcher__glyph" aria-hidden="true">
          {face.glyph}
        </span>
        <span>{face.name}</span>
        <svg className="asafarim-switcher__chevron" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M2 4.5 6 8.5 10 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      {open ? (
        <nav id={menuId} className="asafarim-switcher__menu" aria-label={label} onKeyDown={onMenuKey}>
          <div className="asafarim-switcher__heading">{label}</div>
          {tiles.length === 0 ? (
            <p className="asafarim-switcher__empty">No apps to show right now.</p>
          ) : (
            <ul className="asafarim-switcher__list">
              {tiles.map((t, i) => (
                <li key={t.key}>
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
        </nav>
      ) : null}
    </div>
  );
}
