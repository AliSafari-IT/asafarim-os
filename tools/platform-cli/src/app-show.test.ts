import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appShowCommand, asShownApp, formatAppShow, parseAppShowArgs } from "./apps.ts";

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "app-show-cmd-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  return root;
}

const ENV = { CORE_API_URL: "http://localhost:4020", CORE_API_ADMIN_TOKEN: "tok" };

const NOTES = {
  id: "notes",
  version: "1.2.0",
  state: "active",
  installed_at: "2026-10-12T09:30:00.000Z",
  registered_at: "2026-10-12T09:31:00.000Z",
  permissions: [
    { key: "notes.read", description: "Read notes", deprecated_at: null },
    { key: "notes.share", description: null, deprecated_at: "2026-10-15T10:00:00.000Z" },
    { key: "notes.write", description: "Write notes", deprecated_at: null },
  ],
  roles: [
    { key: "notes.editor", deprecated_at: null },
    { key: "notes.legacy", deprecated_at: "2026-10-15T10:00:00.000Z" },
  ],
};

function reply(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("platform app show: arguments", () => {
  it("takes one app id and --json at most once", () => {
    expect(parseAppShowArgs(["notes"])).toEqual({ id: "notes", json: false });
    expect(parseAppShowArgs(["notes", "--json"])).toEqual({ id: "notes", json: true });
    expect(parseAppShowArgs(["--json", "core"])).toEqual({ id: "core", json: true });
    expect(parseAppShowArgs([])).toBeNull();
    expect(parseAppShowArgs(["--json"])).toBeNull();
    expect(parseAppShowArgs(["notes", "docs"])).toBeNull();
    expect(parseAppShowArgs(["notes", "--json", "--json"])).toBeNull();
    expect(parseAppShowArgs(["notes", "--all"])).toBeNull();
  });

  it("refuses an id core-api's routes wouldn't accept, before any request", async () => {
    for (const bad of ["Notes", "n", "1notes", "notes/../x", "a".repeat(33), "notes_x", "%2e%2e"]) {
      expect(parseAppShowArgs([bad])).toBeNull();
    }
    const fetchImpl = reply(200, NOTES);
    expect(await appShowCommand(["Bad"], workspace(), ENV, fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("platform app show: the app", () => {
  it("asks GET /admin/v1/apps/<id> with the admin token and prints the app", async () => {
    const fetchImpl = reply(200, NOTES);
    const r = await appShowCommand(["notes"], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(true);
    expect(r?.stdout).toBe(true);
    expect(r?.lines).toEqual([
      "App:         notes",
      "Version:     1.2.0",
      "State:       active",
      "Installed:   2026-10-12 09:30 UTC",
      "Registered:  2026-10-12 09:31 UTC",
      "",
      "Permissions (3):",
      "  notes.read   Read notes",
      "  notes.share  (deprecated 2026-10-15 10:00 UTC)",
      "  notes.write  Write notes",
      "Roles (2):",
      "  notes.editor",
      "  notes.legacy  (deprecated 2026-10-15 10:00 UTC)",
      "",
      "Deprecated: no longer declared by the app, kept while a role or grant still uses it.",
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4020/admin/v1/apps/notes");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("says when nothing is declared, the app never registered, and points a removed app at retention", () => {
    const lines = formatAppShow({
      ...NOTES,
      state: "removed",
      registered_at: null,
      permissions: [],
      roles: [],
    });
    expect(lines).toContain("Registered:  not yet");
    expect(lines).toContain("Permissions: none declared");
    expect(lines).toContain("Roles: none declared");
    expect(lines).not.toContain("Deprecated: no longer declared by the app, kept while a role or grant still uses it.");
    expect(lines[lines.length - 1]).toBe("Removed: see pnpm platform app retention for its backup and purge date.");
  });

  it("--json prints core-api's reply unchanged", async () => {
    const r = await appShowCommand(["notes", "--json"], workspace(), ENV, reply(200, NOTES));
    expect(r?.ok).toBe(true);
    expect(r?.stdout).toBe(true);
    expect(JSON.parse(r!.lines.join("\n"))).toEqual(NOTES);
  });

  it("replaces control characters in everything it prints", async () => {
    const evil = {
      ...NOTES,
      version: "1.\u00070",
      state: "act\u001bive",
      installed_at: "soon\u001b[2J",
      permissions: [{ key: "notes.read", description: "x\u001b[2Jy", deprecated_at: null }],
      roles: [{ key: "notes.\u0007ed", deprecated_at: null }],
    };
    const r = await appShowCommand(["notes"], workspace(), ENV, reply(200, evil));
    expect(r?.ok).toBe(true);
    // eslint-disable-next-line no-control-regex
    for (const line of r!.lines) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    const text = r!.lines.join("\n");
    expect(text).toContain("1.?0");
    expect(text).toContain("act?ive");
    expect(text).toContain("soon?[2J");
    expect(text).toContain("x?[2Jy");
    expect(text).toContain("notes.?ed");
  });
});

describe("platform app show: refusals", () => {
  it("fails when core-api is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const r = await appShowCommand(["notes"], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(false);
    expect(r?.lines).toEqual(["core-api isn't reachable at http://localhost:4020 (is `pnpm dev` running?)."]);
  });

  it("names a rejected token, a missing core.admin and an unknown app", async () => {
    const u = await appShowCommand(["notes"], workspace(), ENV, reply(401, { error: "unauthorized" }));
    expect(u?.ok).toBe(false);
    expect(u?.lines).toEqual(["core-api didn't accept the admin token (CORE_API_ADMIN_TOKEN)."]);
    const f = await appShowCommand(["notes"], workspace(), ENV, reply(403, { error: "forbidden" }));
    expect(f?.lines).toEqual(["core-api refused: this sign-in doesn't hold core.admin."]);
    const n = await appShowCommand(["ghost"], workspace(), ENV, reply(404, { error: "not_found" }));
    expect(n?.ok).toBe(false);
    expect(n?.lines).toEqual(['core-api has no app "ghost".']);
  });

  it("replaces control characters in core-api's refusal text", async () => {
    const r = await appShowCommand(
      ["notes"],
      workspace(),
      ENV,
      reply(409, { error: "odd\u001b[2J", message: "x\u0007y" }),
    );
    expect(r?.ok).toBe(false);
    // eslint-disable-next-line no-control-regex
    for (const line of r!.lines) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(r?.lines).toEqual(["core-api refused: odd?[2J (x?y)"]);
  });

  it("fails on a reply that isn't one app, instead of printing garbage", async () => {
    const bodies = [
      [],
      { apps: [] },
      { id: 1, permissions: [], roles: [] },
      { id: "notes", permissions: "x", roles: [] },
      { id: "notes", permissions: [], roles: [null] },
      { id: "notes", permissions: [{ key: 2 }], roles: [] },
    ];
    for (const body of bodies) {
      const r = await appShowCommand(["notes"], workspace(), ENV, reply(200, body));
      expect(r?.ok).toBe(false);
      expect(r?.lines).toEqual(["core-api's reply to GET /admin/v1/apps/notes isn't what this CLI expects."]);
    }
    expect(asShownApp(NOTES)).toEqual(NOTES);
  });

  it("fails without an admin endpoint, before any request", async () => {
    const fetchImpl = reply(200, NOTES);
    const r = await appShowCommand(["notes"], workspace(), {}, fetchImpl);
    expect(r?.ok).toBe(false);
    expect(r?.lines).toHaveLength(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
