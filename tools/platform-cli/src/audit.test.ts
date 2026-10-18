import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { asPage, auditCommand, auditRoute, DETAIL_MAX, formatDetail, parseAuditArgs } from "./audit.ts";

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "audit-cmd-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  return root;
}

const ENV = { CORE_API_URL: "http://localhost:4020", CORE_API_ADMIN_TOKEN: "tok" };

const REMOVED = {
  id: 42,
  at: "2026-10-18T12:30:00.000Z",
  actor: "dev admin",
  action: "app.removed",
  appId: "notes",
  detail: { backup: "notes-20261018.dump" },
};
const GRANTED = {
  id: 41,
  at: "2026-10-18T12:00:00.000Z",
  actor: "dev admin",
  action: "role.granted",
  appId: null,
  detail: {},
};

/** A fetch that answers every call with one reply; records the calls. */
function reply(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("platform audit: arguments", () => {
  it("takes each option once, in any order", () => {
    expect(parseAuditArgs([])).toEqual({ json: false });
    expect(parseAuditArgs(["--json", "--app", "notes", "--actor", "Ali", "--limit", "200", "--before", "40"])).toEqual({
      json: true,
      app: "notes",
      actor: "Ali",
      limit: 200,
      before: 40,
    });
    expect(parseAuditArgs(["--json", "--json"])).toBeNull();
    expect(parseAuditArgs(["--app", "notes", "--app", "docs"])).toBeNull();
  });

  it("rejects missing values, flags as values, and numbers core-api would refuse", () => {
    expect(parseAuditArgs(["--app"])).toBeNull();
    expect(parseAuditArgs(["--app", "--json"])).toBeNull();
    expect(parseAuditArgs(["--actor", ""])).toBeNull();
    expect(parseAuditArgs(["--actor", "x".repeat(129)])).toBeNull();
    expect(parseAuditArgs(["--limit", "0"])).toBeNull();
    expect(parseAuditArgs(["--limit", "201"])).toBeNull();
    expect(parseAuditArgs(["--limit", "-5"])).toBeNull();
    expect(parseAuditArgs(["--limit", "1.5"])).toBeNull();
    expect(parseAuditArgs(["--before", "abc"])).toBeNull();
    expect(parseAuditArgs(["notes"])).toBeNull();
  });

  it("prints the usage (null) for anything else, before any request", async () => {
    const fetchImpl = reply(200, { events: [], next: null });
    expect(await auditCommand(["--nope"], workspace(), ENV, fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("builds the query in Admin's order and encodes it", () => {
    expect(auditRoute({ json: false })).toBe("/admin/v1/audit");
    expect(auditRoute({ json: false, limit: 25, before: 40, actor: "dev admin", app: "notes" })).toBe(
      "/admin/v1/audit?app=notes&actor=dev+admin&before=40&limit=25",
    );
    expect(auditRoute({ json: false, actor: "a&b=c" })).toBe("/admin/v1/audit?actor=a%26b%3Dc");
  });
});

describe("platform audit: the log", () => {
  it("prints newest first with the admin token, and no paging hint on the last page", async () => {
    const fetchImpl = reply(200, { events: [REMOVED, GRANTED], next: null });
    const r = await auditCommand([], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(true);
    expect(r?.stdout).toBe(true);
    const text = r!.lines.join("\n");
    expect(text).toMatch(/^Id\s+At\s+Actor\s+Action\s+App\s+Detail$/m);
    expect(text).toMatch(
      /^42\s+2026-10-18 12:30 UTC\s+dev admin\s+app\.removed\s+notes\s+\{"backup":"notes-20261018\.dump"\}$/m,
    );
    expect(text).toMatch(/^41\s+2026-10-18 12:00 UTC\s+dev admin\s+role\.granted\s+–$/m);
    expect(text.indexOf("42 ")).toBeLessThan(text.indexOf("41 "));
    expect(text).not.toContain("Older events");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4020/admin/v1/audit");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("sends the filters and prints the next page's command, filters kept", async () => {
    const fetchImpl = reply(200, { events: [REMOVED], next: 42 });
    const r = await auditCommand(["--app", "notes", "--limit", "1"], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(true);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://localhost:4020/admin/v1/audit?app=notes&limit=1");
    expect(r!.lines.at(-1)).toBe("Older events: pnpm platform audit --app notes --limit 1 --before 42");
  });

  it("says so when nothing matches", async () => {
    const r = await auditCommand(
      ["--actor", "nobody", "--before", "7"],
      workspace(),
      ENV,
      reply(200, { events: [], next: null }),
    );
    expect(r?.ok).toBe(true);
    expect(r?.lines).toEqual(['No audit events before event 7 match --actor "nobody".']);
    const empty = await auditCommand([], workspace(), ENV, reply(200, { events: [], next: null }));
    expect(empty?.lines).toEqual(["No audit events."]);
  });

  it("--json prints core-api's reply unchanged", async () => {
    const body = { events: [REMOVED], next: null };
    const r = await auditCommand(["--json"], workspace(), ENV, reply(200, body));
    expect(r?.ok).toBe(true);
    expect(r?.stdout).toBe(true);
    expect(JSON.parse(r!.lines.join("\n"))).toEqual(body);
  });

  it("replaces control characters and shortens long details", async () => {
    const evil = {
      ...REMOVED,
      actor: "x\u001b[2Jy",
      action: "app.\u0007installed",
      detail: { note: "a".repeat(200) },
    };
    const r = await auditCommand([], workspace(), ENV, reply(200, { events: [evil], next: null }));
    // eslint-disable-next-line no-control-regex
    for (const line of r!.lines) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    const text = r!.lines.join("\n");
    expect(text).toContain("x?[2Jy");
    expect(text).toContain("app.?installed");
    const row = r!.lines[1]!;
    expect(row.endsWith("…")).toBe(true);
  });
});

describe("platform audit: details", () => {
  it("is empty for no detail, compact JSON otherwise, cut at DETAIL_MAX", () => {
    expect(formatDetail(undefined)).toBe("");
    expect(formatDetail(null)).toBe("");
    expect(formatDetail({})).toBe("");
    expect(formatDetail({ a: 1, b: [true] })).toBe('{"a":1,"b":[true]}');
    expect(formatDetail("plain")).toBe("plain");
    const long = formatDetail({ k: "z".repeat(500) });
    expect(long).toHaveLength(DETAIL_MAX);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("platform audit: refusals", () => {
  it("fails when core-api is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const r = await auditCommand([], workspace(), ENV, fetchImpl);
    expect(r?.ok).toBe(false);
    expect(r?.lines).toEqual(["core-api isn't reachable at http://localhost:4020 (is `pnpm dev` running?)."]);
  });

  it("names a rejected token, a missing core.admin and a missing route", async () => {
    const u = await auditCommand([], workspace(), ENV, reply(401, { error: "unauthorized" }));
    expect(u?.ok).toBe(false);
    expect(u?.lines).toEqual(["core-api didn't accept the admin token (CORE_API_ADMIN_TOKEN)."]);
    const f = await auditCommand([], workspace(), ENV, reply(403, { error: "forbidden" }));
    expect(f?.lines).toEqual(["core-api refused: this sign-in doesn't hold core.admin."]);
    const n = await auditCommand([], workspace(), ENV, reply(404, { error: "not_found" }));
    expect(n?.lines).toEqual(["core-api has no /admin/v1/audit."]);
    const b = await auditCommand(
      [],
      workspace(),
      ENV,
      reply(400, { error: "bad_request", message: "before must be a whole number" }),
    );
    expect(b?.lines).toEqual(["core-api refused: bad_request (before must be a whole number)"]);
  });

  it("fails on a reply that isn't an audit page, instead of printing garbage", async () => {
    for (const body of [[], { events: "nope" }, { events: [{ id: "1" }] }, { events: [null] }]) {
      const r = await auditCommand([], workspace(), ENV, reply(200, body));
      expect(r?.ok).toBe(false);
      expect(r?.lines).toEqual(["core-api's reply to GET /admin/v1/audit isn't what this CLI expects."]);
    }
    expect(asPage({ events: [] })).toEqual({ events: [], next: null });
  });

  it("fails without an admin endpoint, before any request", async () => {
    const fetchImpl = reply(200, { events: [], next: null });
    const r = await auditCommand([], workspace(), {}, fetchImpl);
    expect(r?.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
