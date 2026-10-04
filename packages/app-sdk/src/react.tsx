/**
 * The launcher component (P3.3b): a small, accessible list of the apps the signed-in person can
 * open. Import it from `@asafarim/app-sdk/react` (React is an optional peer, so the rest of the
 * SDK stays free of it). It is presentational: fetch the tiles on the server with
 * `platform.access.launcher(subject)` and pass them in.
 *
 *   <Launcher apps={await platform.access.launcher(subject)} current="notes" />
 *
 * It uses the host app's design tokens when present (--card, --ink, --line, --accent), with
 * light and dark fallbacks, and renders nothing for an empty list.
 */
import type { LauncherTile } from "./launcher.ts";

export interface LauncherProps {
  apps: readonly LauncherTile[];
  /** The app this is rendered in: it is marked as the current page. */
  current?: string;
  /** The landmark's accessible name. */
  label?: string;
}

/** Only http(s) links are rendered: a tile can't smuggle in `javascript:`. */
export function safeHref(href: string): string | undefined {
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export const LAUNCHER_CSS = `
.asafarim-launcher{--l-bg:var(--card,#fff);--l-ink:var(--ink,#1d1b16);--l-line:var(--line,#e4dfd3);--l-accent:var(--accent,#7c3aed)}
@media (prefers-color-scheme:dark){.asafarim-launcher{--l-bg:var(--card,#1f1c17);--l-ink:var(--ink,#f1ece2);--l-line:var(--line,#37322a);--l-accent:var(--accent,#a78bfa)}}
.asafarim-launcher ul{display:flex;flex-wrap:wrap;gap:.5rem;list-style:none;margin:0;padding:0}
.asafarim-launcher a{display:inline-flex;align-items:center;gap:.5rem;padding:.35rem .75rem .35rem .4rem;border:1px solid var(--l-line);border-radius:999px;background:var(--l-bg);color:var(--l-ink);text-decoration:none;font-size:.9rem}
.asafarim-launcher a:hover{border-color:var(--l-accent)}
.asafarim-launcher a:focus-visible{outline:2px solid var(--l-accent);outline-offset:2px}
.asafarim-launcher a[aria-current="page"]{border-color:var(--l-accent);font-weight:600}
.asafarim-launcher__glyph{display:inline-grid;place-items:center;min-width:1.75rem;height:1.75rem;border-radius:999px;background:var(--l-accent);color:#fff;font-size:.7rem;font-weight:700}
`;

export function Launcher({ apps, current, label = "Apps" }: LauncherProps) {
  const tiles = apps.flatMap((a) => {
    const href = safeHref(a.href);
    return href ? [{ ...a, href }] : [];
  });
  if (tiles.length === 0) return null;
  return (
    <nav className="asafarim-launcher" aria-label={label}>
      <style>{LAUNCHER_CSS}</style>
      <ul>
        {tiles.map((a) => (
          <li key={a.key}>
            <a href={a.href} title={a.description} aria-current={a.key === current ? "page" : undefined}>
              <span className="asafarim-launcher__glyph" aria-hidden="true">
                {a.glyph}
              </span>
              <span>{a.name}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
