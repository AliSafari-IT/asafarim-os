/**
 * The ASafariM Knowledge symbol, "Linked K" (#370): a K whose arms end in two nodes, white on the family's
 * gradient tile in the Knowledge teal. Same drawing as app/icon.svg; the top bar shows it in place of the
 * "KN" text tile. Decorative: the brand link next to it carries the name.
 */
export function KnowledgeMark() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width="32"
      height="32"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="kn-brand-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4a97ac" />
          <stop offset=".5" stopColor="#0e7490" />
          <stop offset="1" stopColor="#0a5468" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#kn-brand-g)" />
      <g transform="translate(4.5 4.5) scale(.9583)">
        <g fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7.5 4v16" />
          <path d="M7.5 13 15.3 6.7M10.6 10.7l4.7 6.6" />
        </g>
        <g fill="#fff">
          <circle cx="16.8" cy="5.6" r="2.6" />
          <circle cx="16.8" cy="18.6" r="2.6" />
        </g>
      </g>
    </svg>
  );
}
