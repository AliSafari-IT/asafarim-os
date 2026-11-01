import config from "@asafarim/config/eslint";

/**
 * Flow calls out only through lib/egress (allow-list, address checks, limits, records). Anywhere else
 * a direct network client is a lint error; test/egress-boundary.test.ts checks the same on the files.
 * Calls to core-api go through @asafarim/app-sdk, outside this app, so they're not affected. Tests and
 * the e2e harness talk to their own local stand-ins.
 */
const EGRESS = "Flow calls out only through lib/egress (allow-list, address checks, limits, records).";
// Network clients, name resolution, child processes (curl, a shell) and node:module (createRequire loads
// any of these without an import the rule can see) all lead out of the process.
const NETWORK_MODULES = [
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dgram",
  "dns",
  "dns/promises",
  "child_process",
  "module",
  "undici",
].flatMap((m) => (m === "undici" ? [m] : [m, `node:${m}`]));
const MODULE_NAMES = "(node:)?(https?|http2|net|tls|dgram|dns|child_process|module|undici)(\\u002F.*)?";
/** The egress factories take the overrides (a route, a resolver) that only lib/egress itself may pass. */
const FACTORY =
  "Only lib/egress makes an egress: use `egress` and `smtpEgress` (a factory takes routes and resolvers).";

export default [
  ...config,
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    ignores: ["lib/egress/**", "test/**", "e2e/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...["fetch", "XMLHttpRequest", "WebSocket", "EventSource"].map((name) => ({ name, message: EGRESS })),
      ],
      "no-restricted-properties": [
        "error",
        ...["globalThis", "window", "self", "global"].map((object) => ({ object, property: "fetch", message: EGRESS })),
      ],
      "no-restricted-imports": [
        "error",
        {
          // @asafarim/smtp opens sockets too: email goes out through lib/egress/smtp.ts.
          paths: [...NETWORK_MODULES, "@asafarim/smtp"].map((name) => ({ name, message: EGRESS })),
          patterns: [
            { group: ["undici/*"], message: EGRESS },
            {
              group: ["**/egress", "**/egress/egress", "**/egress/smtp", "@/lib/egress", "@/lib/egress/*"],
              importNames: ["createEgress", "createSmtpEgress"],
              message: FACTORY,
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: `ImportExpression[source.value=/^${MODULE_NAMES}$/]`,
          message: EGRESS,
        },
        {
          selector: `CallExpression[callee.name='require'][arguments.0.value=/^${MODULE_NAMES}$/]`,
          message: EGRESS,
        },
        // fetch reached by another name: `const g = globalThis; g.fetch(…)`, `w["fetch"]`, `const { fetch } = x`.
        { selector: "MemberExpression[property.name='fetch']", message: EGRESS },
        { selector: "MemberExpression[computed=true][property.value='fetch']", message: EGRESS },
        { selector: "ObjectPattern > Property[key.name='fetch']", message: EGRESS },
        { selector: "MemberExpression[object.name='process'][property.name=/^(binding|dlopen)$/]", message: EGRESS },
        {
          selector: "MemberExpression[object.name='process'][computed=true][property.value=/^(binding|dlopen)$/]",
          message: EGRESS,
        },
        // The factories by a dynamic import (a static import is the import rule's, above).
        { selector: "ImportExpression[source.value=/(^|\\u002F)egress\\u002F(egress|smtp)$/]", message: FACTORY },
        // The same modules by a re-export (`export * from "node:http"` is the import rule's too).
        { selector: `ExportAllDeclaration[source.value=/^${MODULE_NAMES}$/]`, message: EGRESS },
      ],
    },
  },
];
