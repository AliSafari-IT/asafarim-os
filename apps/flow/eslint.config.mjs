import config from "@asafarim/config/eslint";

/**
 * Flow calls out only through lib/egress (allow-list, address checks, limits, records). Anywhere else
 * a direct network client is a lint error; test/egress-boundary.test.ts checks the same on the files.
 * Calls to core-api go through @asafarim/app-sdk, outside this app, so they're not affected. Tests and
 * the e2e harness talk to their own local stand-ins.
 */
const EGRESS = "Flow calls out only through lib/egress (allow-list, address checks, limits, records).";
const NETWORK_MODULES = ["http", "https", "http2", "net", "tls", "dgram", "undici"].flatMap((m) =>
  m === "undici" ? [m] : [m, `node:${m}`],
);

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
          patterns: [{ group: ["undici/*"], message: EGRESS }],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: `ImportExpression[source.value=/^(node:)?(https?|http2|net|tls|dgram|undici)(\\u002F.*)?$/]`,
          message: EGRESS,
        },
        {
          selector: `CallExpression[callee.name='require'][arguments.0.value=/^(node:)?(https?|http2|net|tls|dgram|undici)(\\u002F.*)?$/]`,
          message: EGRESS,
        },
      ],
    },
  },
];
