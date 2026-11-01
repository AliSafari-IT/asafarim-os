/**
 * lib/egress is the only way Flow calls out. Two guards: every source file outside lib/egress is
 * searched for a network client (fetch, http(s), http2, net, tls, dgram, undici, imported, required
 * or called), and the lint config is checked to flag the same while leaving lib/egress alone. Calls
 * to core-api go through @asafarim/app-sdk (outside this app); tests and the e2e harness talk to their
 * own local stand-ins, so test/ and e2e/ are exempt by path.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
// eslint.config.mjs names what it bans.
const EXEMPT = ["lib/egress/", "test/", "e2e/", "node_modules/", ".next/", "eslint.config.mjs"];

const files = readdirSync(ROOT, { recursive: true })
  .map((f) => String(f).split(path.sep).join("/"))
  .filter((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f) && !f.endsWith(".d.ts"))
  .filter((f) => !EXEMPT.some((e) => f.startsWith(e)));

const MODULES =
  "(?:node:)?(?:https?|http2|net|tls|dgram|dns(?:/promises)?|child_process|module)|undici(?:/[\\w/-]+)?|@asafarim/smtp";
const PATTERNS: [string, RegExp][] = [
  ["fetch(", /(?<![\w.])fetch\s*\(|\.fetch\s*\(|\bfetch\s*\)/],
  ["XMLHttpRequest / WebSocket / EventSource", /\b(?:XMLHttpRequest|WebSocket|EventSource)\b/],
  ["an import of a network module", new RegExp(`from\\s+["'](?:${MODULES})["']`)],
  ["a dynamic import of a network module", new RegExp(`import\\s*\\(\\s*["'](?:${MODULES})["']`)],
  ["a require of a network module", new RegExp(`require\\s*\\(\\s*["'](?:${MODULES})["']`)],
];

/** The code without its comments, so a comment that says "fetched" is no finding. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("the egress boundary", () => {
  it("finds the app's source files (and lib/egress is left out)", () => {
    expect(files).toContain("app/actions.ts");
    expect(files).toContain("lib/engine/engine.ts");
    expect(files.some((f) => f.startsWith("lib/egress/"))).toBe(false);
  });

  it("no file outside lib/egress uses a network client", () => {
    const findings = files.flatMap((f) => {
      const src = code(readFileSync(path.join(ROOT, f), "utf8"));
      return PATTERNS.filter(([, re]) => re.test(src)).map(([what]) => `${f}: ${what}`);
    });
    expect(findings).toEqual([]);
  });

  it("the search finds each form it looks for", () => {
    const hits = (src: string) => PATTERNS.some(([, re]) => re.test(code(src)));
    for (const src of [
      'await fetch("https://x")',
      'globalThis.fetch("https://x")',
      'import https from "node:https"',
      'import { request } from "http"',
      'import net from "net"',
      'import { connect } from "node:tls"',
      'import { SmtpClient } from "@asafarim/smtp"',
      'import { request } from "undici"',
      'const m = await import("node:http")',
      'const u = require("undici/lib/x")',
      "new WebSocket(u)",
    ])
      expect({ src, hit: hits(src) }).toEqual({ src, hit: true });
    expect(hits("// this is fetched later\nconst fetched = 1;")).toBe(false);
  });

  it("the lint rule flags them outside lib/egress, and not inside it", async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const lint = async (text: string, file: string) =>
      (await eslint.lintText(text, { filePath: path.join(ROOT, file) }))[0]!.messages.map((m) => m.ruleId);
    const samples = [
      'export const a = () => fetch("https://example.com");\n',
      'export const a = () => globalThis.fetch("https://example.com");\n',
      'import https from "node:https";\nexport const a = https;\n',
      'import net from "net";\nexport const a = net;\n',
      'import { request } from "undici";\nexport const a = request;\n',
      'export const a = () => import("node:tls");\n',
      'import { SmtpClient } from "@asafarim/smtp";\nexport const a = SmtpClient;\n',
    ];
    for (const s of samples) {
      expect(await lint(s, "lib/connector.ts")).not.toEqual([]);
      expect(await lint(s, "lib/egress/inside.ts")).toEqual([]);
    }
  }, 60_000);

  // #307 C4: each of these got past the rule once; every one is a negative test now.
  it("the lint rule also flags DNS, child processes, re-exports, aliases of the global object and an egress made outside lib/egress", async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const lint = async (text: string, file: string) =>
      (await eslint.lintText(text, { filePath: path.join(ROOT, file) }))[0]!.messages.map((m) => m.ruleId);
    const samples: [string, string][] = [
      ["node:dns", 'import dns from "node:dns";\nexport const a = dns;\n'],
      ["dns", 'import { lookup } from "dns";\nexport const a = lookup;\n'],
      ["dns/promises", 'import { resolve4 } from "node:dns/promises";\nexport const a = resolve4;\n'],
      ["child_process", 'import { exec } from "child_process";\nexport const a = exec;\n'],
      ["node:child_process", 'import cp from "node:child_process";\nexport const a = cp;\n'],
      ["a dynamic import of dns", 'export const a = () => import("node:dns");\n'],
      ["a require of child_process", 'export const a = require("node:child_process");\n'],
      ["a re-export of http", 'export { request } from "node:http";\n'],
      ["a star re-export of https", 'export * from "node:https";\n'],
      ["a re-export of dns", 'export { lookup } from "node:dns";\n'],
      ["an aliased import", 'import { request as send } from "http";\nexport const a = send;\n'],
      [
        "the global object under another name",
        'const g = globalThis;\nexport const a = () => g.fetch("https://example.com");\n',
      ],
      ["fetch by a computed name", 'export const a = () => globalThis["fetch"]("https://example.com");\n'],
      [
        "fetch taken from an object",
        'export const a = (w: { fetch: typeof fetch }) => w.fetch("https://example.com");\n',
      ],
      [
        "createRequire",
        'import { createRequire } from "node:module";\nexport const a = createRequire(import.meta.url);\n',
      ],
      ["process.binding", 'export const a = () => process.binding("tcp_wrap");\n'],
      [
        "createEgress from the barrel",
        'import { createEgress } from "@/lib/egress";\nexport const a = createEgress({ route: () => undefined });\n',
      ],
      [
        "createEgress by a relative path",
        'import { createEgress } from "../egress/egress";\nexport const a = createEgress({});\n',
      ],
      ["createEgress renamed", 'import { createEgress as make } from "@/lib/egress";\nexport const a = make({});\n'],
      [
        "createSmtpEgress",
        'import { createSmtpEgress } from "@/lib/egress/smtp";\nexport const a = createSmtpEgress({});\n',
      ],
      ["createEgress re-exported", 'export { createEgress } from "@/lib/egress";\n'],
    ];
    // Only the boundary rules count: another rule (no-require-imports) may flag a sample for its own reasons.
    const boundary = async (text: string, file: string) =>
      (await lint(text, file)).filter((id) => id?.startsWith("no-restricted"));
    const missed: string[] = [];
    for (const [what, src] of samples) if ((await boundary(src, "lib/connector.ts")).length === 0) missed.push(what);
    expect(missed).toEqual([]);
    // Inside lib/egress the same code is the module's own business.
    for (const [, src] of samples) expect(await boundary(src, "lib/egress/inside.ts")).toEqual([]);
    // What the app does use is not flagged.
    const ok = 'import { egress, smtpEgress } from "@/lib/egress";\nexport const a = [egress, smtpEgress];\n';
    expect(await lint(ok, "lib/connector.ts")).toEqual([]);
  }, 60_000);

  it("the file search knows dns and child_process too", () => {
    const hits = (src: string) => PATTERNS.some(([, re]) => re.test(code(src)));
    for (const src of [
      'import { lookup } from "node:dns"',
      'import { resolve } from "dns/promises"',
      'import { exec } from "child_process"',
      'const cp = require("node:child_process")',
      'export { request } from "node:http"',
    ])
      expect({ src, hit: hits(src) }).toEqual({ src, hit: true });
  });
});
