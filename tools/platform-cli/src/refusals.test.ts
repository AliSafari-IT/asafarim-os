/**
 * Every admin command prints core-api's refusal text; none may pass a control character (an ANSI
 * escape could rewrite the screen, CWE-150) through to the terminal. `request` cleans a refusal's
 * error and message once; `app install`/`activate`/`role grant` read their own replies.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appCommand, roleCommand } from "./app.ts";
import { appListCommand, appShowCommand } from "./apps.ts";
import { auditCommand } from "./audit.ts";
import { eventsCommand } from "./events.ts";
import { formatDate, request, retentionCommand, type Terminal } from "./retention.ts";
import { roleReadCommand } from "./roles.ts";
import { statusCommand } from "./status.ts";
import { clean } from "./text.ts";

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "refusals-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  return root;
}

const ENV = { CORE_API_URL: "http://localhost:4020", CORE_API_ADMIN_TOKEN: "tok" };
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
const pipe: Terminal = { isTTY: false, ask: async () => "" };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const HOSTILE = { error: "odd\u001b[2J", message: "x\u0007y\u009bz" };

type Run = (fetchImpl: typeof fetch) => Promise<{ ok: boolean; lines: string[] } | null>;

const commands: [string, Run][] = [
  ["status", (f) => statusCommand([], workspace(), ENV, f)],
  ["status --alerts", (f) => statusCommand(["--alerts"], workspace(), ENV, f)],
  ["audit", (f) => auditCommand([], workspace(), ENV, f)],
  ["app list", (f) => appListCommand([], workspace(), ENV, f)],
  ["app show", (f) => appShowCommand(["notes"], workspace(), ENV, f)],
  ["role list", (f) => roleReadCommand(["list"], workspace(), ENV, f)],
  ["role holders", (f) => roleReadCommand(["holders", "notes.editor"], workspace(), ENV, f)],
  ["role held-by", (f) => roleReadCommand(["held-by", "dev-member"], workspace(), ENV, f)],
  ["events", (f) => eventsCommand([], workspace(), ENV, f)],
  ["events search", (f) => eventsCommand(["search", "note"], workspace(), ENV, f)],
  ["app retention", (f) => retentionCommand(["retention"], workspace(), ENV, f, pipe)],
  ["app remove", (f) => retentionCommand(["remove", "notes", "--confirm", "notes"], workspace(), ENV, f, pipe)],
  ["app purge", (f) => retentionCommand(["purge", "notes", "--confirm", "notes"], workspace(), ENV, f, pipe)],
  ["app activate", (f) => appCommand(["activate", "notes"], workspace(), ENV, f)],
  ["role grant", (f) => roleCommand(["grant", "notes.editor", "dev-member"], workspace(), ENV, f)],
];

describe("core-api's refusal text is cleaned for the terminal", () => {
  it.each(commands)("%s", async (_name, run) => {
    const r = await run(reply(409, HOSTILE));
    expect(r?.ok).toBe(false);
    for (const line of r!.lines) expect(line).not.toMatch(CONTROL);
    // The text is still shown, with each control character replaced by "?".
    expect(r!.lines.join("\n")).toContain("odd?[2J");
    expect(r!.lines.join("\n")).toContain("x?y?z");
  });

  it("the remove and purge messages that quote core-api are cleaned too", async () => {
    const cases: [string[], object][] = [
      [["remove", "notes", "--confirm", "notes"], { error: "backup_failed", message: "pg\u001b]0;x\u0007" }],
      [["remove", "notes", "--confirm", "notes"], { error: "invalid_state", message: "a\u001bb" }],
      [["purge", "notes", "--confirm", "notes"], { error: "bad_request", message: "a\u001bb" }],
      [
        ["purge", "notes", "--confirm", "notes"],
        { error: "purge_refused", details: { reason: "backup_missing", backup: { path: "/x\u001b[1m.dump" } } },
      ],
      [
        ["purge", "notes", "--confirm", "notes"],
        { error: "purge_refused", details: { reason: "retention", purgeAfter: "soon\u001b[5m" } },
      ],
    ];
    for (const [args, body] of cases) {
      const r = await retentionCommand(args, workspace(), ENV, reply(409, body), pipe);
      expect(r?.ok, JSON.stringify(body)).toBe(false);
      for (const line of r!.lines) expect(line, JSON.stringify(body)).not.toMatch(CONTROL);
    }
  });

  it("install's validation details are cleaned, whatever their type", async () => {
    const root = workspace();
    const body = {
      error: "invalid_manifest",
      details: [
        { path: "name\u001b[2J", message: "bad\u0007" },
        { path: ["events", 0], message: 42 },
      ],
    };
    const r = await appCommand(["activate", "notes"], root, ENV, reply(400, body));
    expect(r).toEqual({
      ok: false,
      lines: ["core-api refused: invalid_manifest", "  name?[2J: bad?", "  events,0: 42"],
    });
  });

  it("plain refusals read as before", async () => {
    const r = await auditCommand([], workspace(), ENV, reply(418, { error: "teapot", message: "short and stout" }));
    expect(r?.lines).toEqual(["core-api refused: teapot (short and stout)"]);
    const g = await roleCommand(
      ["grant", "notes.ghost", "u"],
      workspace(),
      ENV,
      reply(404, { error: "role_not_found", message: 'no active role "notes.ghost"' }),
    );
    expect(g?.lines).toEqual(['core-api refused: role_not_found (no active role "notes.ghost")']);
  });
});

describe("request and formatDate", () => {
  it("request cleans a refusal's error and message, and keeps plain codes as they are", async () => {
    const target = { baseUrl: "http://localhost:4020", token: "tok" };
    expect(await request(target, "GET", "/x", reply(409, HOSTILE))).toMatchObject({
      ok: false,
      status: 409,
      error: "odd?[2J",
      message: "x?y?z",
    });
    expect(await request(target, "GET", "/x", reply(403, { error: "forbidden" }))).toEqual({
      ok: false,
      status: 403,
      error: "forbidden",
    });
    // A successful reply is returned as sent; each command cleans what it prints from it.
    expect(await request(target, "GET", "/x", reply(200, { name: "a\u001bb" }))).toEqual({
      ok: true,
      out: { name: "a\u001bb" },
    });
  });

  it("formatDate passes a string it can't parse through, cleaned", () => {
    expect(formatDate("2026-11-15T10:00:00.000Z")).toBe("2026-11-15 10:00 UTC");
    expect(formatDate("soon\u001b[5m")).toBe("soon?[5m");
  });

  it("clean replaces C0, DEL and C1 characters and turns a non-string into ?", () => {
    expect(clean("a\u0000b\u001fc\u007fd\u0085e\u009ff")).toBe("a?b?c?d?e?f");
    expect(clean("plain é ✓")).toBe("plain é ✓");
    expect(clean(42)).toBe("?");
  });
});
