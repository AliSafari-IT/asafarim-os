/**
 * The app's name for the top bar's left side: its glyph tile and name, a link to the app's home. It goes
 * with <AppSwitcher variant="icon"> next to the account menu, so the top bar shows one brand, not the
 * switcher's tile beside a logo (#288). Static: no client code.
 *
 *   <AppBrand name="Flow" glyph="FL" href="/" />
 *
 * Pass `as="h1"` where the brand is the page's main heading (an app with no other <h1>).
 */
export interface AppBrandProps {
  name: string;
  glyph: string;
  /** The app's home (default "/"). */
  href?: string;
  /** The element around the link: "h1" when the brand is the page's heading, else a plain div. */
  as?: "div" | "h1";
}

export const APP_BRAND_CSS = `
.asafarim-brand{--b-ink:var(--ink,#1d1b16);--b-accent:var(--accent,#7c3aed);--b-accent-ink:var(--accent-ink,#fff);margin:0;font-size:1rem;line-height:1}
@media (prefers-color-scheme:dark){.asafarim-brand{--b-ink:var(--ink,#f1ece2);--b-accent:var(--accent,#a78bfa);--b-accent-ink:var(--accent-ink,#15130f)}}
.asafarim-brand__link{display:inline-flex;align-items:center;gap:.5rem;padding:.25rem .5rem .25rem .25rem;border-radius:10px;color:var(--b-ink);font-weight:700;text-decoration:none}
.asafarim-brand__link:focus-visible{outline:2px solid var(--b-accent);outline-offset:2px}
.asafarim-brand__glyph{display:inline-grid;place-items:center;flex:none;width:2rem;height:2rem;border-radius:8px;background:linear-gradient(135deg,var(--b-accent),color-mix(in srgb,var(--b-accent) 65%,#000));color:var(--b-accent-ink);font-size:.75rem;font-weight:700;box-shadow:inset 0 1px 0 rgb(255 255 255 / .25)}
`;

export function AppBrand({ name, glyph, href = "/", as = "div" }: AppBrandProps) {
  const Tag = as;
  return (
    <Tag className="asafarim-brand" data-testid="app-brand">
      <style>{APP_BRAND_CSS}</style>
      <a className="asafarim-brand__link" href={href}>
        <span className="asafarim-brand__glyph" aria-hidden="true">
          {glyph}
        </span>
        <span>{name}</span>
      </a>
    </Tag>
  );
}
