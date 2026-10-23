/**
 * The Admin console's mark: the ASafariM OS core (asafarim.site's brand mark, a rounded square with
 * apps orbiting it) turned into a control panel, its three sliders gliding as if someone were tuning
 * the platform. A pulse rings out from the core and a light sweeps across it now and then.
 *
 * All motion is CSS (globals.css, `.admin-logo`), so "reduce motion" leaves a still mark. The colours
 * are the brand tokens (`--accent`, `--accent-ink`), so it follows light and dark. Decorative: the
 * text next to it names the console.
 */
export function AdminLogo({ size = 36, idPrefix = "admin-logo" }: { size?: number; idPrefix?: string }) {
  // SVG ids are document-wide: two marks on one page need different prefixes.
  const core = `${idPrefix}-core`;
  const sheen = `${idPrefix}-sheen`;
  const clip = `${idPrefix}-clip`;
  return (
    <svg
      className="admin-logo"
      viewBox="0 0 48 48"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      data-testid="admin-logo"
    >
      <defs>
        <linearGradient id={core} x1="0" y1="0" x2="1" y2="1">
          <stop className="admin-logo-stop-a" offset="0" />
          <stop className="admin-logo-stop-b" offset="1" />
        </linearGradient>
        <linearGradient id={sheen} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={clip}>
          <rect x="12" y="12" width="24" height="24" rx="7" />
        </clipPath>
      </defs>

      <circle className="admin-logo-pulse" cx="24" cy="24" r="13" />
      <circle className="admin-logo-ring" cx="24" cy="24" r="20.5" />
      <g className="admin-logo-orbit">
        <circle cx="24" cy="3.5" r="2.6" />
      </g>
      <g className="admin-logo-orbit admin-logo-orbit-slow">
        <circle cx="44.5" cy="24" r="1.8" />
      </g>

      <g className="admin-logo-core">
        <rect x="12" y="12" width="24" height="24" rx="7" fill={`url(#${core})`} />
        <g clipPath={`url(#${clip})`}>
          <rect className="admin-logo-sheen" x="-6" y="6" width="10" height="36" fill={`url(#${sheen})`} />
        </g>
        <g className="admin-logo-tracks">
          <path d="M17.5 18.5h13M17.5 24h13M17.5 29.5h13" />
        </g>
        <circle className="admin-logo-knob admin-logo-knob-1" cx="21" cy="18.5" r="2.3" />
        <circle className="admin-logo-knob admin-logo-knob-2" cx="27" cy="24" r="2.3" />
        <circle className="admin-logo-knob admin-logo-knob-3" cx="23" cy="29.5" r="2.3" />
      </g>
    </svg>
  );
}
