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

const MODULES = "(?:node:)?(?:https?|http2|net|tls|dgram)|undici(?:/[\\w/-]+)?|@asafarim/smtp";
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
});
