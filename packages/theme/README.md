# @asafarim/theme

The ASafariM OS look, shared by asafarim.site, id.asafarim.site, the Admin console and every app, so they read as one product.

- **Light**: a cool light-blue page, white cards, navy actions.
- **Dark**: charcoal, with light-blue actions.
- **Top bar**: charcoal in both themes (`.os-topbar`).
- **Toggle**: a sun that sets into a moon. The choice is kept in the `asafarim-theme` cookie on the parent domain, so it holds on every `*.asafarim.site` host. Until someone picks a theme, pages follow the system setting.

| File                    | What it is                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `theme.css`             | The tokens (`--bg`, `--card`, `--ink`, `--muted`, `--line`, `--accent`, `--accent-ink`, …), `.os-topbar` and the toggle's styles. Load it before the page's own stylesheet.    |
| `theme.js`              | The browser script: applies the remembered choice before paint, flips it on any `[data-theme-toggle]` click, writes the cookie. No inline script needed (`script-src 'self'`). |
| `toggle.html`           | The toggle's markup, for pages that aren't React.                                                                                                                              |
| `@asafarim/theme`       | For servers: `THEME_COOKIE`, `parseTheme()`, `themeFromCookieHeader()`.                                                                                                        |
| `@asafarim/theme/react` | `<ThemeToggle />` for Next.js apps (it loads `theme.js`).                                                                                                                      |

## In a Next.js app

```tsx
// app/layout.tsx
import { parseTheme, THEME_COOKIE } from "@asafarim/theme";
import { cookies } from "next/headers";
import "@asafarim/theme/theme.css";
import "./globals.css";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme}>
      <body>{children}</body>
    </html>
  );
}
```

Then put `className="os-topbar"` on the header and `<ThemeToggle />` from `@asafarim/theme/react` in it, and add `@asafarim/theme` to `transpilePackages`.

## App-specific tokens with a dark value

Give them the same three blocks the package uses: the light value on `:root`, the dark value under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }`, and the dark value again under `:root[data-theme="dark"]`.
