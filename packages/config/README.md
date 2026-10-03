# @asafarim/config

Shared presets for every workspace in this repo.

```jsonc
// tsconfig.json
{ "extends": "@asafarim/config/tsconfig/base.json" }      // apps, services, tools (no emit)
{ "extends": "@asafarim/config/tsconfig/library.json" }   // packages that emit .d.ts
```

```js
// eslint.config.js
import config from "@asafarim/config/eslint";
export default config;
```
