import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  clean,
  formatAlerts,
  formatStatus,
  healthy,
  parseStatusArgs,
  statusCommand,
  type StatusReport,
} from "./status.ts";

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "status-cmd-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  return root;
}

const ENV = { CORE_API_URL: "http://localhost:4020", CORE_API_ADMIN_TOKEN: "tok" };

const CORE = {
  id: "core-api",
  name: "Core API",
  state: "active",
  polled: true,
  live: "up",
  ready: "up",
  latencyMs: 3,
  checkedAt: "2026-10-18T11:00:00.000Z",
  since: "2026-10-18T09:00:00.000Z",
} as const;
const NOTES = { ...CORE, id: "notes", name: "Notes", latencyMs: 12 };
const DOCS_INACTIVE = {
  ...CORE,
  id: "docs",
  name: "Docs",
  state: "inactive",
  polled: false,
  live: "unknown",
  ready: "unknown",
  latencyMs: null,
  checkedAt: null,
} as const;
const NOTES_DOWN = { ...NOTES, ready: "down", error: "bad_status", detail: "503" } as const;

const board = (apps: unknown[], checkedAt: string | null = "2026-10-18T11:00:05.000Z") => ({
  checkedAt,
  intervalMs: 15000,
  apps,
});

const HISTORY = {
  webhook: false,
  downRounds: 2,
  alerts: [
    {
      at: "2026-10-18T10:58:00.000Z",
      kind: "recovered",
      id: "notes",
      name: "Notes",
      live: "up",
      ready: "up",
    },
    {
      at: "2026-10-18T10:40:00.000Z",
      kind: "down",
      id: "notes",
      name: "Notes",
      live: "up",
      ready: "down",
      error: "bad_status",
      detail: "503",
    },
  ],
};

/** A fetch that answers by route; records the calls. */
function routes(map: Record<string, [number, unknown]>) {
  return vi.fn(async (url: string | URL | Request) => {
    const route = new URL(String(url)).pathname;
    const [status, body] = map[route] ?? [404, { error: "not_found" }];
    return new Response(JSON.stringify(body), { status });
  });
}

describe("platform status: arguments", () => {
  it("takes --alerts and --json, each once, in any order", () => {
    expect(parseStatusArgs([])).toEqual({ alerts: false, json: false });
    expect(parseStatusArgs(["--json", "--alerts"])).toEqual({ alerts: true, json: true });
    expect(parseStatusArgs(["--alerts", "--alerts"])).toBeNull();
    expect(parseStatusArgs(["notes"])).toBeNull();
    expect(parseStatusArgs(["--verbose"])).toBeNull();
  });

  it("prints the usage (null) for anything else, before any request", async () => {
    const fetchImpl = routes({});
    expect(await statusCommand(["--nope"], workspace(), ENV, fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("platform status: the board", () => {
  it("is healthy (exit 0) when every polled entry is live and ready; inactive apps don't count", async () => {
    const fetchImpl = routes({ "/admin/v1/status": [200, board([CORE, NOTES, DOCS_INACTIVE])] });
    const r = await statusCommand([], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(true);
    expect(r?.stdout).toBe(true);
    const text = r!.lines.join("\n");
    expect(text).toMatch(/^App\s+State\s+Live\s+Ready\s+Latency\s+Checked\s+Error$/m);
    expect(text).toMatch(/^notes\s+active\s+up\s+up\s+12 ms\s+2026-10-18 11:00 UTC$/m);
    expect(text).toMatch(/^docs\s+inactive\s+–\s+–\s+–\s+not polled$/m);
    expect(text).toContain("Last round: 2026-10-18 11:00 UTC, every 15 s.");
    expect(text).toContain("Everything polled is live and ready.");
    // Only the board was asked for, with the admin token.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4020/admin/v1/status");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("fails (exit 1, still on stdout) when a polled entry isn't live and ready, and names it", async () => {
    const fetchImpl = routes({ "/admin/v1/status": [200, board([CORE, NOTES_DOWN])] });
    const r = await statusCommand([], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(false);
    expect(r?.stdout).toBe(true);
    const text = r!.lines.join("\n");
    expect(text).toMatch(/^notes\s+active\s+up\s+down\s+12 ms\s+2026-10-18 11:00 UTC\s+bad_status \(503\)$/m);
    expect(text).toContain("Not live and ready: notes.");
  });

  it("fails before core-api has finished a round (nothing is known to be up)", async () => {
    const empty = await statusCommand([], workspace(), ENV, routes({ "/admin/v1/status": [200, board([], null)] }));
    expect(empty?.ok).toBe(false);
    expect(empty?.lines).toEqual(["core-api hasn't finished a health round yet (or its health poller is off)."]);

    const unknown = { ...CORE, live: "unknown", ready: "unknown", latencyMs: null, checkedAt: null };
    const first = await statusCommand(
      [],
      workspace(),
      ENV,
      routes({ "/admin/v1/status": [200, board([unknown], null)] }),
    );
    expect(first?.ok).toBe(false);
    expect(first?.lines.join("\n")).toContain("No round has finished yet, so nothing is known to be up.");
  });

  it("replaces control characters from manifest text, so a name can't rewrite the terminal", () => {
    expect(clean("Notes\u001b[2J\u0007")).toBe("Notes?[2J?");
    expect(clean(42)).toBe("?");
    const lines = formatStatus(board([{ ...NOTES, id: "notes", state: "act\u001bive" }]) as StatusReport);
    expect(lines.join("\n")).not.toContain("\u001b");
  });

  it("healthy() needs a finished round and ignores entries that aren't polled", () => {
    expect(healthy(board([CORE, DOCS_INACTIVE]) as StatusReport)).toBe(true);
    expect(healthy(board([CORE], null) as StatusReport)).toBe(false);
    expect(healthy(board([CORE, NOTES_DOWN]) as StatusReport)).toBe(false);
  });
});

describe("platform status --alerts", () => {
  it("adds the alert history, newest first as core-api sends it, and whether a webhook is set (never its URL)", async () => {
    const fetchImpl = routes({
      "/admin/v1/status": [200, board([CORE, NOTES])],
      "/admin/v1/alerts": [200, HISTORY],
    });
    const r = await statusCommand(["--alerts"], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(true);
    const text = r!.lines.join("\n");
    expect(text).toContain(
      'Recent alerts (no webhook is set, so alerts are recorded, not sent; "down" after 2 round(s)):',
    );
    const rec = text.indexOf("recovered");
    const down = text.search(/\bdown\s+notes \(Notes\)/);
    expect(rec).toBeGreaterThan(0);
    expect(down).toBeGreaterThan(rec);
    expect(text).toMatch(/2026-10-18 10:40 UTC\s+down\s+notes \(Notes\)\s+live up, ready down\s+bad_status \(503\)/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("says so when there are no alerts, and when a webhook is set", () => {
    expect(formatAlerts({ webhook: true, downRounds: 3, alerts: [] })).toEqual([
      "",
      'Recent alerts (a webhook is set; "down" after 3 round(s)):',
      "  none",
    ]);
  });

  it("a down app still fails the command with --alerts", async () => {
    const fetchImpl = routes({
      "/admin/v1/status": [200, board([NOTES_DOWN])],
      "/admin/v1/alerts": [200, HISTORY],
    });
    expect((await statusCommand(["--alerts"], workspace(), ENV, fetchImpl))?.ok).toBe(false);
  });
});

describe("platform status --json", () => {
  it("prints core-api's replies as they are, with the same exit rule", async () => {
    const status = board([CORE, NOTES_DOWN]);
    const fetchImpl = routes({ "/admin/v1/status": [200, status], "/admin/v1/alerts": [200, HISTORY] });
    const r = await statusCommand(["--json", "--alerts"], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(false);
    expect(r?.stdout).toBe(true);
    expect(JSON.parse(r!.lines.join("\n"))).toEqual({ status, alerts: HISTORY });

    const only = await statusCommand(
      ["--json"],
      workspace(),
      ENV,
      routes({ "/admin/v1/status": [200, board([CORE])] }),
    );
    expect(only?.ok).toBe(true);
    expect(JSON.parse(only!.lines.join("\n"))).toEqual({ status: board([CORE]) });
  });
});

describe("platform status: refusals (stderr, exit 1)", () => {
  it("core-api not reachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const r = await statusCommand([], workspace(), ENV, fetchImpl);
    expect(r).toEqual({
      ok: false,
      lines: ["core-api isn't reachable at http://localhost:4020 (is `pnpm dev` running?)."],
    });
  });

  it("a wrong admin token, and a sign-in without core.admin", async () => {
    const unauthorized = await statusCommand(
      [],
      workspace(),
      ENV,
      routes({ "/admin/v1/status": [401, { error: "unauthorized" }] }),
    );
    expect(unauthorized).toEqual({
      ok: false,
      lines: ["core-api didn't accept the admin token (CORE_API_ADMIN_TOKEN)."],
    });

    const forbidden = await statusCommand(
      ["--alerts"],
      workspace(),
      ENV,
      routes({ "/admin/v1/status": [200, board([CORE])], "/admin/v1/alerts": [403, { error: "forbidden" }] }),
    );
    expect(forbidden).toEqual({ ok: false, lines: ["core-api refused: this sign-in doesn't hold core.admin."] });
  });

  it("no admin token: nothing is sent", async () => {
    const fetchImpl = routes({});
    const r = await statusCommand([], workspace(), { CORE_API_URL: "http://localhost:4020" }, fetchImpl);
    expect(r?.ok).toBe(false);
    expect(r?.lines[0]).toMatch(/CORE_API_ADMIN_TOKEN is not set/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a core-api without the route (404) is named as such, not as a missing app", async () => {
    const r = await statusCommand([], workspace(), ENV, routes({}));
    expect(r).toEqual({
      ok: false,
      lines: ["core-api has no /admin/v1/status (it may be older than the status board or alert history)."],
    });
    const a = await statusCommand(["--alerts"], workspace(), ENV, routes({ "/admin/v1/status": [200, board([CORE])] }));
    expect(a?.lines).toEqual([
      "core-api has no /admin/v1/alerts (it may be older than the status board or alert history).",
    ]);
  });

  it("a reply that isn't a board or a history fails instead of throwing", async () => {
    for (const body of [board([null]), board([{ name: "no id" }]), { apps: "x" }, null, [CORE]]) {
      const r = await statusCommand([], workspace(), ENV, routes({ "/admin/v1/status": [200, body] }));
      expect(r).toEqual({
        ok: false,
        lines: ["core-api's reply to GET /admin/v1/status isn't what this CLI expects."],
      });
    }
    for (const json of [[], ["--json"]]) {
      const r = await statusCommand(
        ["--alerts", ...json],
        workspace(),
        ENV,
        routes({ "/admin/v1/status": [200, board([CORE])], "/admin/v1/alerts": [200, { ...HISTORY, alerts: [null] }] }),
      );
      expect(r).toEqual({
        ok: false,
        lines: ["core-api's reply to GET /admin/v1/alerts isn't what this CLI expects."],
      });
    }
  });
});
