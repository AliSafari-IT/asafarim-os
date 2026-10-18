import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appListCommand, asAppList, formatAppList, parseAppListArgs } from "./apps.ts";

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "app-list-cmd-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  return root;
}

const ENV = { CORE_API_URL: "http://localhost:4020", CORE_API_ADMIN_TOKEN: "tok" };

const CORE = {
  id: "core",
  name: "ASafariM OS core",
  version: "0.4.0",
  state: "active",
  system: true,
  installed_at: "2026-10-01T08:00:00.000Z",
  registered_at: null,
  permissions: 3,
  roles: 1,
  waitingForPublisher: [],
  retention: null,
};
const NOTES = {
  ...CORE,
  id: "notes",
  name: "Notes",
  version: "1.2.0",
  system: false,
  installed_at: "2026-10-12T09:30:00.000Z",
  permissions: 4,
  roles: 2,
  waitingForPublisher: ["docs.page.published"],
};
const OLD = {
  ...CORE,
  id: "old-app",
  name: "Old app",
  version: "0.1.0",
  state: "removed",
  system: false,
  permissions: 0,
  roles: 0,
  retention: {
    removedAt: "2026-10-15T10:00:00.000Z",
    database: "app_old_app",
    backup: null,
    purgeAfter: "2026-11-14T10:00:00.000Z",
    purgedAt: null,
    eligible: false,
  },
};

/** A fetch that answers every call with one reply; records the calls. */
function reply(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("platform app list: arguments", () => {
  it("takes --json at most once and nothing else", () => {
    expect(parseAppListArgs([])).toEqual({ json: false });
    expect(parseAppListArgs(["--json"])).toEqual({ json: true });
    expect(parseAppListArgs(["--json", "--json"])).toBeNull();
    expect(parseAppListArgs(["notes"])).toBeNull();
    expect(parseAppListArgs(["--all"])).toBeNull();
  });

  it("prints the usage (null) for anything else, before any request", async () => {
    const fetchImpl = reply(200, { apps: [] });
    expect(await appListCommand(["--nope"], workspace(), ENV, fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("platform app list: the list", () => {
  it("prints one row per app in core-api's order, with the admin token", async () => {
    const fetchImpl = reply(200, { apps: [CORE, NOTES, OLD] });
    const r = await appListCommand([], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(true);
    expect(r?.stdout).toBe(true);
    const text = r!.lines.join("\n");
    expect(text).toMatch(/^Id\s+Name\s+Version\s+State\s+Installed\s+Roles\s+Permissions$/m);
    expect(text).toMatch(/^core\s+ASafariM OS core\s+0\.4\.0\s+active \(system\)\s+2026-10-01 08:00 UTC\s+1\s+3$/m);
    expect(text).toMatch(/^notes\s+Notes\s+1\.2\.0\s+active\s+2026-10-12 09:30 UTC\s+2\s+4$/m);
    expect(text).toMatch(/^old-app\s+Old app\s+0\.1\.0\s+removed\s+/m);
    expect(text.indexOf("core ")).toBeLessThan(text.indexOf("notes "));
    expect(text.indexOf("notes ")).toBeLessThan(text.indexOf("old-app "));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4020/admin/v1/apps");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("adds a line for apps waiting on a publisher and for removed apps", () => {
    const lines = formatAppList([CORE, NOTES, OLD] as never);
    expect(lines).toContain("Waiting for a publisher (a warning; nothing is blocked):");
    expect(lines).toContain("  notes: subscribes to docs.page.published, but no installed app publishes it");
    expect(lines).toContain("Removed (see pnpm platform app retention):");
    expect(lines).toContain("  old-app: removed 2026-10-15 10:00 UTC, purge allowed from 2026-11-14 10:00 UTC");
  });

  it("says when a removed app's database is purged or there was none", () => {
    const purged = { ...OLD, retention: { ...OLD.retention, purgedAt: "2026-11-20T00:00:00.000Z" } };
    const none = { ...OLD, id: "tiny", retention: { ...OLD.retention, database: null, purgeAfter: null } };
    const lines = formatAppList([purged, none] as never);
    expect(lines).toContain("  old-app: removed 2026-10-15 10:00 UTC, database purged 2026-11-20 00:00 UTC");
    expect(lines).toContain("  tiny: removed 2026-10-15 10:00 UTC, no database kept");
  });

  it("has no notes when nothing waits and nothing is removed", () => {
    const lines = formatAppList([CORE] as never);
    expect(lines).toHaveLength(2);
  });

  it("says so when core-api lists no apps", async () => {
    const r = await appListCommand([], workspace(), ENV, reply(200, { apps: [] }));
    expect(r?.ok).toBe(true);
    expect(r?.lines).toEqual(["core-api lists no apps."]);
  });

  it("--json prints core-api's reply unchanged", async () => {
    const body = { apps: [CORE, OLD] };
    const r = await appListCommand(["--json"], workspace(), ENV, reply(200, body));
    expect(r?.ok).toBe(true);
    expect(r?.stdout).toBe(true);
    expect(JSON.parse(r!.lines.join("\n"))).toEqual(body);
  });

  it("replaces control characters and shows ? for missing counts", async () => {
    const evil = {
      ...NOTES,
      name: "x\u001b[2Jy",
      version: "1.\u00070",
      roles: undefined,
      waitingForPublisher: ["a\u001bb"],
    };
    const r = await appListCommand([], workspace(), ENV, reply(200, { apps: [evil] }));
    // eslint-disable-next-line no-control-regex
    for (const line of r!.lines) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    const text = r!.lines.join("\n");
    expect(text).toContain("x?[2Jy");
    expect(text).toContain("1.?0");
    expect(text).toContain("a?b");
    expect(text).toMatch(/^notes\s+x\?\[2Jy\s+1\.\?0\s+active\s+2026-10-12 09:30 UTC\s+\?\s+4$/m);
  });
});

describe("platform app list: refusals", () => {
  it("fails when core-api is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const r = await appListCommand([], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(false);
    expect(r?.lines).toEqual(["core-api isn't reachable at http://localhost:4020 (is `pnpm dev` running?)."]);
  });

  it("names a rejected token, a missing core.admin and a missing route", async () => {
    const u = await appListCommand([], workspace(), ENV, reply(401, { error: "unauthorized" }));
    expect(u?.ok).toBe(false);
    expect(u?.lines).toEqual(["core-api didn't accept the admin token (CORE_API_ADMIN_TOKEN)."]);
    const f = await appListCommand([], workspace(), ENV, reply(403, { error: "forbidden" }));
    expect(f?.lines).toEqual(["core-api refused: this sign-in doesn't hold core.admin."]);
    const n = await appListCommand([], workspace(), ENV, reply(404, { error: "not_found" }));
    expect(n?.lines).toEqual(["core-api has no /admin/v1/apps."]);
  });

  it("fails on a reply that isn't an app list, instead of printing garbage", async () => {
    for (const body of [[], { apps: "nope" }, { apps: [{ id: 1 }] }, { apps: [null] }]) {
      const r = await appListCommand([], workspace(), ENV, reply(200, body));
      expect(r?.ok).toBe(false);
      expect(r?.lines).toEqual(["core-api's reply to GET /admin/v1/apps isn't what this CLI expects."]);
    }
    expect(asAppList({ apps: [] })).toEqual([]);
  });

  it("fails without an admin endpoint, before any request", async () => {
    const fetchImpl = reply(200, { apps: [] });
    const r = await appListCommand([], workspace(), {}, fetchImpl);
    expect(r?.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
