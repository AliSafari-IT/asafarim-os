# @asafarim/locale

The languages of ASafariM OS, shared by asafarim.site, id.asafarim.site, the Admin console and every app, so a visitor picks a language once:

- **Languages:** English, Nederlands, Français and Deutsch (Belgium's three languages plus English, as on asafarim.com). English is the default.
- **One choice everywhere:** the `asafarim-locale` cookie on the parent domain, so it holds on every `*.asafarim.site` host.
- **One selector:** [`@asafarim/country-language-selector`](https://www.npmjs.com/package/@asafarim/country-language-selector), the component asafarim.com uses, bundled once in this package.

| File               | What it is                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@asafarim/locale` | For servers and builds: `LOCALES`, `negotiateLocale()` (URL, then cookie, then browser, then English), `localeCookie()`, `localeSwitcher()`, `alternateLinks()`. |
| `selector.js`      | The selector with React, as one plain browser script. Load it with `<script src defer>` from the page's own origin (`script-src 'self'`).                        |
| `selector.css`     | Its styles and the no-JavaScript fallback's. Load it after `@asafarim/theme/theme.css`.                                                                          |

## On a page

```ts
import { alternateLinks, localeSwitcher } from "@asafarim/locale";

const href = (l) => (l === "en" ? "https://asafarim.site/" : `https://asafarim.site/${l}/`);
// in <head>: <link rel="stylesheet" href="/selector.css"> <script src="/selector.js" defer></script> + alternateLinks(href)
// in the top bar:
localeSwitcher(locale, href);
```

`localeSwitcher()` renders one plain link per language inside the selector's mount. Without JavaScript those links work as they are. With it, `selector.js` reads them, shows the selector instead, and on a choice writes the cookie and goes to that language's link. Where each language lives (a path prefix, `?lang=`, another host) is up to the page.

A server-rendered app reads the choice with `negotiateLocale({ query, cookieHeader, acceptLanguage })`, and when it came from the URL remembers it with `localeCookie(locale, host)`.

## Upgrading the selector

The pinned version lives here and only here:

1. Bump `@asafarim/country-language-selector` in this package's `package.json` and run `pnpm install`.
2. Run `pnpm --filter @asafarim/locale build:selector` and commit `selector.js` and `selector.css`.

`test/selector.test.ts` fails while the committed files differ from a fresh build. Images copy the two files from this package, so every site and app ships the new version on its next build.
