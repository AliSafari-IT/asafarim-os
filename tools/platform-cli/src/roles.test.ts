import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  asGrantList,
  asRoleList,
  formatHeldBy,
  formatHolders,
  formatRoleList,
  parseRoleReadArgs,
  roleReadCommand,
  roleReadRoute,
} from "./roles.ts";

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "role-read-cmd-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  return root;
}

const ENV = { CORE_API_URL: "http://localhost:4020", CORE_API_ADMIN_TOKEN: "tok" };

const ADMIN = {
  key: "core.admin",
  appId: "core",
  description: "Administers the platform",
  deprecated: false,
  permissions: [{ key: "core.apps.manage", deprecated: false }],
  deprecatedPermissions: [],
  migrationNeeded: false,
  holders: 1,
};
const EDITOR = {
  key: "notes.editor",
  appId: "notes",
  description: "Writes notes",
  deprecated: false,
  permissions: [
    { key: "notes.read", deprecated: false },
    { key: "notes.write", deprecated: false },
    { key: "notes.share", deprecated: true },
  ],
  deprecatedPermissions: ["notes.share"],
  migrationNeeded: true,
  holders: 3,
};
const OLD = {
  key: "notes.viewer",
  appId: "notes",
  description: null,
  deprecated: true,
  permissions: [],
  deprecatedPermissions: [],
  migrationNeeded: false,
  holders: 2,
};

/** A fetch that answers every call with one reply; records the calls. */
function reply(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

function call(fetchImpl: ReturnType<typeof reply>) {
  return fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
}

describe("platform role list|holders|held-by: arguments", () => {
  it("parses each read and its options, each at most once", () => {
    expect(parseRoleReadArgs(["list"])).toEqual({ action: "list", json: false });
    expect(parseRoleReadArgs(["list", "--json"])).toEqual({ action: "list", json: true });
    expect(parseRoleReadArgs(["list", "--app", "notes"])).toEqual({ action: "list", app: "notes", json: false });
    expect(parseRoleReadArgs(["list", "--app", "core", "--json"])).toEqual({ action: "list", app: "core", json: true });
    expect(parseRoleReadArgs(["holders", "notes.editor"])).toEqual({
      action: "holders",
      role: "notes.editor",
      json: false,
    });
    expect(parseRoleReadArgs(["held-by", "--json", "user:42@x"])).toEqual({
      action: "held-by",
      subject: "user:42@x",
      json: true,
    });
  });

  it("refuses what core-api would refuse, and anything extra", () => {
    for (const args of [
      ["list", "notes"],
      ["list", "--app"],
      ["list", "--app", "Notes"],
      ["list", "--app", "a", "--app", "b"],
      ["list", "--json", "--json"],
      ["list", "--all"],
      ["holders"],
      ["holders", "editor"],
      ["holders", "notes.editor", "notes.viewer"],
      ["holders", "notes.editor", "--app", "notes"],
      ["held-by"],
      ["held-by", "a b"],
      ["held-by", "x".repeat(129)],
      ["held-by", "a/b"],
      ["show", "notes.editor"],
      [],
    ]) {
      expect(parseRoleReadArgs(args), args.join(" ")).toBeNull();
    }
  });

  it("asks the route Admin asks, with the subject percent-encoded", () => {
    expect(roleReadRoute({ action: "list", json: false })).toBe("/admin/v1/roles");
    expect(roleReadRoute({ action: "list", app: "notes", json: false })).toBe("/admin/v1/roles?app=notes");
    expect(roleReadRoute({ action: "holders", role: "notes.editor", json: false })).toBe(
      "/admin/v1/roles/notes.editor/grants",
    );
    expect(roleReadRoute({ action: "held-by", subject: "user:42@x", json: false })).toBe(
      "/admin/v1/subjects/user%3A42%40x/grants",
    );
  });

  it("prints the usage (null) for anything else, before any request", async () => {
    const fetchImpl = reply(200, { roles: [] });
    expect(await roleReadCommand(["list", "--nope"], workspace(), ENV, fetchImpl)).toBeNull();
    expect(await roleReadCommand(["holders", "x"], workspace(), ENV, fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("platform role list", () => {
  it("prints one row per role in core-api's order, with the admin token", async () => {
    const fetchImpl = reply(200, { roles: [ADMIN, EDITOR, OLD] });
    const r = await roleReadCommand(["list"], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(true);
    expect(r?.stdout).toBe(true);
    const text = r!.lines.join("\n");
    expect(text).toMatch(/^Role\s+App\s+Holders\s+Permissions\s+Description$/m);
    expect(text).toMatch(/^core\.admin\s+core\s+1\s+1\s+Administers the platform$/m);
    expect(text).toMatch(/^notes\.editor\s+notes\s+3\s+3\s+Writes notes$/m);
    expect(text).toMatch(/^notes\.viewer\s+notes\s+2\s+0$/m);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = call(fetchImpl);
    expect(url).toBe("http://localhost:4020/admin/v1/roles");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("filters by app", async () => {
    const fetchImpl = reply(200, { roles: [EDITOR] });
    const r = await roleReadCommand(["list", "--app", "notes"], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(true);
    expect(call(fetchImpl)[0]).toBe("http://localhost:4020/admin/v1/roles?app=notes");
  });

  it("notes deprecated roles and roles that still grant a deprecated permission", () => {
    const lines = formatRoleList([ADMIN, EDITOR, OLD] as never);
    expect(lines).toContain("Deprecated roles (kept while someone holds them):");
    expect(lines).toContain("  notes.viewer: no longer declared by notes; held by 2");
    expect(lines).toContain("Needs migrating (ADR 0001 §3.4):");
    expect(lines).toContain("  notes.editor: still grants notes.share, which the app no longer declares");
  });

  it("has no notes when nothing is deprecated", () => {
    expect(formatRoleList([ADMIN] as never)).toHaveLength(2);
  });

  it("says so when there are no roles, for all apps or one", async () => {
    const all = await roleReadCommand(["list"], workspace(), ENV, reply(200, { roles: [] }));
    expect(all?.ok).toBe(true);
    expect(all?.lines).toEqual(["core-api lists no roles."]);
    const one = await roleReadCommand(["list", "--app", "notes"], workspace(), ENV, reply(200, { roles: [] }));
    expect(one?.lines).toEqual(["notes declares no roles."]);
  });

  it("replaces control characters and shows ? for missing counts", async () => {
    const odd = {
      ...EDITOR,
      description: "a\u001b[2Jb",
      holders: "many",
      permissions: "x",
      deprecatedPermissions: ["n\u0007s"],
    };
    const r = await roleReadCommand(["list"], workspace(), ENV, reply(200, { roles: [odd] }));
    expect(r?.ok).toBe(true);
    // eslint-disable-next-line no-control-regex
    for (const line of r!.lines) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    const text = r!.lines.join("\n");
    expect(text).toMatch(/^notes\.editor\s+notes\s+\?\s+\?\s+a\?\[2Jb$/m);
    expect(text).toContain("still grants n?s");
  });

  it("--json prints core-api's reply unchanged", async () => {
    const body = { roles: [ADMIN] };
    const r = await roleReadCommand(["list", "--json"], workspace(), ENV, reply(200, body));
    expect(r?.ok).toBe(true);
    expect(JSON.parse(r!.lines.join("\n"))).toEqual(body);
  });
});

describe("platform role holders", () => {
  const GRANTS = [
    { subject: "alice", granted_by: "cli", granted_at: "2026-10-12T09:30:00.000Z" },
    { subject: "bob", granted_by: "admin:alice", granted_at: "2026-10-14T18:05:00.000Z" },
  ];

  it("prints who holds the role, when and by whom", async () => {
    const fetchImpl = reply(200, { role: "notes.editor", grants: GRANTS });
    const r = await roleReadCommand(["holders", "notes.editor"], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(true);
    expect(r?.lines).toEqual([
      "Subject  Granted               Granted by",
      "alice    2026-10-12 09:30 UTC  cli",
      "bob      2026-10-14 18:05 UTC  admin:alice",
    ]);
    expect(call(fetchImpl)[0]).toBe("http://localhost:4020/admin/v1/roles/notes.editor/grants");
  });

  it("says so when nobody holds it (core-api answers an empty list for an unknown role too)", async () => {
    const r = await roleReadCommand(["holders", "notes.editor"], workspace(), ENV, reply(200, { grants: [] }));
    expect(r?.lines).toEqual(["Nobody holds notes.editor."]);
  });

  it("replaces control characters in what core-api sends", () => {
    const lines = formatHolders("notes.editor", [{ subject: "a\u0007", granted_by: "b\u001b", granted_at: "x\u0000" }]);
    // eslint-disable-next-line no-control-regex
    for (const line of lines) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});

describe("platform role held-by", () => {
  it("prints every role the person holds, across apps", async () => {
    const fetchImpl = reply(200, {
      subject: "user:42@x",
      grants: [
        { role: "core.admin", appId: "core", granted_by: "cli", granted_at: "2026-10-01T08:00:00.000Z" },
        { role: "notes.editor", appId: "notes", granted_by: "cli", granted_at: "2026-10-12T09:30:00.000Z" },
      ],
    });
    const r = await roleReadCommand(["held-by", "user:42@x"], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(true);
    expect(r?.lines).toEqual([
      "Role          App    Granted               Granted by",
      "core.admin    core   2026-10-01 08:00 UTC  cli",
      "notes.editor  notes  2026-10-12 09:30 UTC  cli",
    ]);
    expect(call(fetchImpl)[0]).toBe("http://localhost:4020/admin/v1/subjects/user%3A42%40x/grants");
  });

  it("says so when the person holds nothing", () => {
    expect(formatHeldBy("bob", [])).toEqual(["bob holds no roles."]);
  });
});

describe("platform role list|holders|held-by: refusals", () => {
  it("fails when core-api is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const r = await roleReadCommand(["list"], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(false);
    expect(r?.lines).toEqual(["core-api isn't reachable at http://localhost:4020 (is `pnpm dev` running?)."]);
  });

  it("names a rejected token, a missing core.admin, a missing route and a bad request", async () => {
    const u = await roleReadCommand(["list"], workspace(), ENV, reply(401, { error: "unauthorized" }));
    expect(u?.ok).toBe(false);
    expect(u?.lines).toEqual(["core-api didn't accept the admin token (CORE_API_ADMIN_TOKEN)."]);
    const f = await roleReadCommand(["holders", "notes.editor"], workspace(), ENV, reply(403, { error: "forbidden" }));
    expect(f?.lines).toEqual(["core-api refused: this sign-in doesn't hold core.admin."]);
    const n = await roleReadCommand(["list", "--app", "notes"], workspace(), ENV, reply(404, { error: "not_found" }));
    expect(n?.lines).toEqual(["core-api has no /admin/v1/roles."]);
    const b = await roleReadCommand(
      ["held-by", "bob"],
      workspace(),
      ENV,
      reply(400, { error: "bad_request", message: "nope" }),
    );
    expect(b?.lines).toEqual(["core-api refused: bad_request (nope)"]);
  });

  it("fails on a reply it doesn't expect, instead of printing garbage", async () => {
    for (const body of [[], { roles: "nope" }, { roles: [{ key: 1 }] }, { roles: [null] }]) {
      const r = await roleReadCommand(["list"], workspace(), ENV, reply(200, body));
      expect(r?.ok).toBe(false);
      expect(r?.lines).toEqual(["core-api's reply to GET /admin/v1/roles isn't what this CLI expects."]);
    }
    // holders lists subjects, held-by lists roles: the other shape is not accepted.
    const h = await roleReadCommand(
      ["holders", "notes.editor"],
      workspace(),
      ENV,
      reply(200, { grants: [{ role: "x" }] }),
    );
    expect(h?.ok).toBe(false);
    const s = await roleReadCommand(["held-by", "bob"], workspace(), ENV, reply(200, { grants: [{ subject: "x" }] }));
    expect(s?.ok).toBe(false);
    expect(asRoleList({ roles: [] })).toEqual([]);
    expect(asGrantList({ grants: [] }, "role")).toEqual([]);
  });

  it("fails without an admin endpoint, before any request", async () => {
    const fetchImpl = reply(200, { roles: [] });
    const r = await roleReadCommand(["list"], workspace(), {}, fetchImpl);
    expect(r?.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
