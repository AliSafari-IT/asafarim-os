import config from "@asafarim/config/eslint";
import globals from "globals";

export default [
  // The generated bundle (scripts/build-selector.ts); test/selector.test.ts checks it instead.
  { ignores: ["selector.js"] },
  ...config,
  { files: ["src/selector.client.tsx"], languageOptions: { globals: globals.browser } },
];
