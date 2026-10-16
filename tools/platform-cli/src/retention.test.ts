import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { formatBytes, formatDate, parseRetentionArgs, retentionCommand, type Terminal } from "./retention.ts";

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "retention-cmd-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  return root;
}

const ENV = { CORE_API_URL: "http://localhost:4020", CORE_API_ADMIN_TOKEN: "tok" };
const reply = (status: number, body: object) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

/** A terminal that answers `answer` when asked (and records the questions), or a pipe (not a TTY). */
const tty = (answer: string) => {
  const ask = vi.fn(async (_q: string) => answer);
  return { isTTY: true, ask } satisfies Terminal;
};
const pipe = () => ({ isTTY: false, ask: vi.fn(async (_q: string) => "notes") }) satisfies Terminal;

const SHA = "abcdef0123456789".repeat(4);
const BACKUP = {
  id: 7,
  database: "app_notes",
  path: "/var/backups/notes-20261016T091949Z-x1.dump",
  sizeBytes: 5 * 1024 * 1024 + 300 * 1024,
  sha256: SHA,
  createdAt: "2026-10-16T09:19:49.000Z",
};
const REMOVED = {
  appId: "notes",
  state: "removed",
  previous: "inactive",
  from: "inactive",
  revokedCredentials: 1,
  removedGrants: [{ role: "notes.editor", subject: "dev-member" }],
  removedEventSchemas: [],
  removedAt: "2026-10-16T09:19:49.000Z",
  backup: BACKUP,
  purgeAfter: "2026-11-15T09:19:49.000Z",
  warnings: [],
};
const PURGED = {
  appId: "notes",
  state: "removed",
  database: { name: "app_notes", result: "dropped" },
  role: { name: "app_notes", result: "absent" },
  backup: BACKUP,
  removedAt: "2026-10-16T09:19:49.000Z",
  purgeAfter: "2026-11-15T09:19:49.000Z",
  purgedAt: "2026-11-16T10:00:00.000Z",
  forced: false,
};

const call = (fetchImpl: ReturnType<typeof reply>, n = 0) =>
  fetchImpl.mock.calls[n] as unknown as [string, RequestInit];

describe("platform app remove|purge|retention: arguments", () => {
  it("parses each command and its flags", () => {
    expect(parseRetentionArgs(["remove", "notes"])).toEqual({ action: "remove", id: "notes", yes: false });
    expect(parseRetentionArgs(["remove", "notes", "--confirm", "notes", "--yes"])).toEqual({
      action: "remove",
      id: "notes",
      confirm: "notes",
      yes: true,
    });
    expect(parseRetentionArgs(["purge", "notes", "--force", "--confirm", "notes"])).toEqual({
      action: "purge",
      id: "notes",
      force: true,
      confirm: "notes",
      yes: false,
    });
    expect(parseRetentionArgs(["purge", "notes"])).toEqual({ action: "purge", id: "notes", force: false, yes: false });
    expect(parseRetentionArgs(["retention"])).toEqual({ action: "retention", eligible: false });
    expect(parseRetentionArgs(["retention", "--eligible"])).toEqual({ action: "retention", eligible: true });
  });

  it("refuses malformed input (the usage is printed)", () => {
    for (const bad of [
      ["remove"],
      ["remove", "Bad_Id"],
      ["remove", "notes", "--force"], // --force is purge's only
      ["remove", "notes", "--confirm"], // --confirm needs a value
      ["remove", "notes", "--confirm", "notes", "--confirm", "notes"],
      ["remove", "notes", "extra"],
      ["purge", "--force", "notes"],
      ["purge", "notes", "--force", "--force"],
      ["retention", "--all"],
      ["retention", "--eligible", "x"],
      ["delete", "notes"],
    ]) {
      expect(parseRetentionArgs(bad), bad.join(" ")).toBeNull();
    }
  });

  it("a malformed command returns null and calls nothing", async () => {
    const fetchImpl = reply(200, {});
    expect(await retentionCommand(["remove", "Bad_Id"], workspace(), ENV, fetchImpl, tty("Bad_Id"))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("formats sizes and dates", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(5 * 1024 * 1024 + 300 * 1024)).toBe("5.3 MiB");
    expect(formatDate("2026-11-15T09:19:49.000Z")).toBe("2026-11-15 09:19 UTC");
    expect(formatDate(null)).toBe("–");
  });
});

describe("platform app remove: the id is stated twice", () => {
  it("prompts on a terminal; the typed id goes ahead", async () => {
    const term = tty("notes\n");
    const fetchImpl = reply(200, REMOVED);
    const r = await retentionCommand(["remove", "notes"], workspace(), ENV, fetchImpl, term);
    expect(r?.ok).toBe(true);
    expect(term.ask).toHaveBeenCalledOnce();
    expect(term.ask.mock.calls[0]![0]).toContain("Type notes to remove it");
    const [url, init] = call(fetchImpl);
    expect(url).toBe("http://localhost:4020/admin/v1/apps/notes/remove");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("a typed mismatch (or nothing) aborts and makes no HTTP call", async () => {
    for (const typed of ["note", "NOTES", "", "notes-2"]) {
      const fetchImpl = reply(200, REMOVED);
      const r = await retentionCommand(["remove", "notes"], workspace(), ENV, fetchImpl, tty(typed));
      expect(r?.ok, typed).toBe(false);
      expect(r!.lines.at(-1)).toBe("Nothing was removed.");
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("--confirm <id> replaces the prompt; a mismatched --confirm aborts with no call", async () => {
    const term = tty("ignored");
    const ok = reply(200, REMOVED);
    expect((await retentionCommand(["remove", "notes", "--confirm", "notes"], workspace(), ENV, ok, term))?.ok).toBe(
      true,
    );
    expect(term.ask).not.toHaveBeenCalled();

    const fetchImpl = reply(200, REMOVED);
    const r = await retentionCommand(["remove", "notes", "--confirm", "other"], workspace(), ENV, fetchImpl, term);
    expect(r).toEqual({ ok: false, lines: ['--confirm "other" isn\'t "notes".', "Nothing was removed."] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("--yes never replaces the id: alone it refuses, with a matching --confirm it goes ahead", async () => {
    for (const term of [tty("notes"), pipe()]) {
      const fetchImpl = reply(200, REMOVED);
      const r = await retentionCommand(["remove", "notes", "--yes"], workspace(), ENV, fetchImpl, term);
      expect(r?.ok).toBe(false);
      expect(r!.lines[0]).toContain("--confirm notes");
      expect(term.ask).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    const fetchImpl = reply(200, REMOVED);
    const r = await retentionCommand(
      ["remove", "notes", "--yes", "--confirm", "notes"],
      workspace(),
      ENV,
      fetchImpl,
      pipe(),
    );
    expect(r?.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("stdin not a terminal: refused without --confirm (nothing is read or sent), accepted with it", async () => {
    const term = pipe();
    const fetchImpl = reply(200, REMOVED);
    const r = await retentionCommand(["remove", "notes"], workspace(), ENV, fetchImpl, term);
    expect(r?.ok).toBe(false);
    expect(r!.lines[0]).toMatch(/stdin isn't a terminal.*--confirm notes/);
    expect(term.ask).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    const r2 = await retentionCommand(["remove", "notes", "--confirm", "notes"], workspace(), ENV, fetchImpl, term);
    expect(r2?.ok).toBe(true);
  });

  it("needs the admin token before it asks anything", async () => {
    const term = tty("notes");
    const fetchImpl = reply(200, REMOVED);
    const r = await retentionCommand(["remove", "notes"], workspace(), {}, fetchImpl, term);
    expect(r?.lines[0]).toMatch(/CORE_API_ADMIN_TOKEN/);
    expect(term.ask).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("platform app remove: output", () => {
  it("prints the backup path, size, sha256 prefix and purge date", async () => {
    const r = await retentionCommand(
      ["remove", "notes", "--confirm", "notes"],
      workspace(),
      ENV,
      reply(200, REMOVED),
      pipe(),
    );
    expect(r?.ok).toBe(true);
    const text = r!.lines.join("\n");
    expect(r!.lines[0]).toBe("notes removed (was inactive): 1 credential(s) revoked, 1 grant(s) deleted.");
    expect(text).toContain(`backup       ${BACKUP.path}`);
    expect(text).toContain("size         5.3 MiB");
    expect(text).toContain("sha256       abcdef012345…");
    expect(text).not.toContain(SHA);
    expect(text).toContain("purge after  2026-11-15 09:19 UTC");
    expect(text).toContain("platform app purge notes");
  });

  it("an app without a database says there is nothing to purge", async () => {
    const r = await retentionCommand(
      ["remove", "notes", "--confirm", "notes"],
      workspace(),
      ENV,
      reply(200, { ...REMOVED, backup: null, purgeAfter: null, warnings: [{ app: "b", type: "t", code: "w" }] }),
      pipe(),
    );
    const text = r!.lines.join("\n");
    expect(text).toContain("nothing was backed up and there is nothing to purge");
    expect(text).toContain("1 subscription(s) of other apps now wait for a publisher");
  });

  it("maps each error to a plain message", async () => {
    const cases: [number, object, RegExp][] = [
      [
        503,
        { error: "backup_failed", message: "pg_dump exited 1" },
        /couldn't back up notes's database: pg_dump exited 1/,
      ],
      [
        409,
        { error: "invalid_state", message: "can't remove an active app: deactivate it first" },
        /notes can't be removed: can't remove an active app: deactivate it first/,
      ],
      [404, { error: "not_found", message: 'no app "notes"' }, /core-api has no app "notes"/],
      [
        503,
        { error: "bus_unavailable", message: "nats down" },
        /event bus couldn't be cleaned up for notes \(nats down\)/,
      ],
      [503, { error: "registry_busy" }, /busy with another install/],
      [401, { error: "unauthorized" }, /didn't accept the admin token/],
      [403, { error: "forbidden" }, /doesn't hold core.admin/],
      [418, { error: "teapot", message: "short and stout" }, /^core-api refused: teapot \(short and stout\)$/],
    ];
    for (const [status, body, expected] of cases) {
      const r = await retentionCommand(
        ["remove", "notes", "--confirm", "notes"],
        workspace(),
        ENV,
        reply(status, body),
        pipe(),
      );
      expect(r?.ok, JSON.stringify(body)).toBe(false);
      expect(r!.lines[0], JSON.stringify(body)).toMatch(expected);
      expect(r!.lines.join("\n")).toContain("Nothing was removed.");
    }
  });

  it("core-api unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const r = await retentionCommand(
      ["remove", "notes", "--confirm", "notes"],
      workspace(),
      ENV,
      fetchImpl as unknown as typeof fetch,
      pipe(),
    );
    expect(r).toEqual({
      ok: false,
      lines: ["core-api isn't reachable at http://localhost:4020 (is `pnpm dev` running?).", "Nothing was removed."],
    });
  });
});

describe("platform app purge", () => {
  it("asks for the id like remove; a mismatch makes no call", async () => {
    const fetchImpl = reply(200, PURGED);
    const r = await retentionCommand(["purge", "notes"], workspace(), ENV, fetchImpl, tty("nope"));
    expect(r?.ok).toBe(false);
    expect(r!.lines.at(-1)).toBe("Nothing was dropped.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("--force without the typed or --confirm id makes no call", async () => {
    for (const [args, term] of [
      [["purge", "notes", "--force"], pipe()],
      [["purge", "notes", "--force"], tty("")],
      [["purge", "notes", "--force"], tty("note")],
      [["purge", "notes", "--force", "--yes"], tty("notes")],
      [["purge", "notes", "--force", "--confirm", "other"], tty("notes")],
    ] as [string[], Terminal][]) {
      const fetchImpl = reply(200, PURGED);
      const r = await retentionCommand(args, workspace(), ENV, fetchImpl, term);
      expect(r?.ok, args.join(" ")).toBe(false);
      expect(fetchImpl, args.join(" ")).not.toHaveBeenCalled();
    }
  });

  it("without --force sends no force; with it sends force and the confirmed id", async () => {
    const plain = reply(200, PURGED);
    await retentionCommand(["purge", "notes"], workspace(), ENV, plain, tty("notes"));
    const [url, init] = call(plain);
    expect(url).toBe("http://localhost:4020/admin/v1/apps/notes/purge");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({});

    const forced = reply(200, { ...PURGED, forced: true });
    const r = await retentionCommand(
      ["purge", "notes", "--force", "--confirm", "notes"],
      workspace(),
      ENV,
      forced,
      pipe(),
    );
    expect(JSON.parse(String(call(forced)[1].body))).toEqual({ force: true, confirm: "notes" });
    expect(r!.lines[0]).toBe("notes purged (forced: before its retention window was over):");
  });

  it("prints what was dropped and where the backup is", async () => {
    const r = await retentionCommand(["purge", "notes"], workspace(), ENV, reply(200, PURGED), tty("notes"));
    expect(r?.ok).toBe(true);
    expect(r!.lines).toEqual([
      "notes purged:",
      "  database app_notes: dropped",
      "  role     app_notes: absent",
      "",
      `The backup ${BACKUP.path} (sha256 abcdef012345…) is the only copy of its data now.`,
      `Restore it with \`pg_restore --create --dbname=postgres ${BACKUP.path}\`.`,
    ]);
  });

  it("before the purge date, without --force, it refuses and prints the date", async () => {
    const r = await retentionCommand(
      ["purge", "notes", "--confirm", "notes"],
      workspace(),
      ENV,
      reply(409, {
        error: "purge_refused",
        message: "notes's retention window isn't over",
        details: { reason: "retention", purgeAfter: "2026-11-15T09:19:49.000Z" },
      }),
      pipe(),
    );
    expect(r).toEqual({
      ok: false,
      lines: [
        "notes's retention window isn't over: it can be purged from 2026-11-15 09:19 UTC.",
        "To purge it before then, add --force (the id is still confirmed).",
        "Nothing was dropped.",
      ],
    });
  });

  it("maps every purge_refused reason and the other errors to a plain message", async () => {
    const refused = (details: object) => [409, { error: "purge_refused", message: "m", details }] as const;
    const cases: [number, object, RegExp][] = [
      [...refused({ reason: "no_backup" }), /^notes has no recorded backup, so its database is kept\.$/],
      [
        ...refused({ reason: "backup_missing", backup: BACKUP }),
        new RegExp(`backup ${BACKUP.path} isn't there any more`),
      ],
      [...refused({ reason: "backup_mismatch", backup: BACKUP }), /doesn't match its recorded sha256/],
      [...refused({ reason: "something_new" }), /^core-api refused the purge: m\.$/],
      [
        400,
        { error: "bad_request", message: 'a forced purge needs "confirm": "notes"' },
        /refused the purge request: a forced purge needs/,
      ],
      [
        409,
        { error: "invalid_state", message: "notes was already purged" },
        /^notes can't be purged: notes was already purged\.$/,
      ],
      [404, { error: "not_found" }, /core-api has no app "notes"/],
    ];
    for (const [status, body, expected] of cases) {
      const r = await retentionCommand(
        ["purge", "notes", "--confirm", "notes"],
        workspace(),
        ENV,
        reply(status, body),
        pipe(),
      );
      expect(r?.ok, JSON.stringify(body)).toBe(false);
      expect(r!.lines[0], JSON.stringify(body)).toMatch(expected);
      expect(r!.lines.at(-1)).toBe("Nothing was dropped.");
    }
  });
});

describe("platform app retention", () => {
  const entries = [
    {
      appId: "notes",
      name: "Notes",
      removedAt: "2026-09-01T08:00:00.000Z",
      database: "app_notes",
      backup: BACKUP,
      purgeAfter: "2026-10-01T08:00:00.000Z",
      purgedAt: null,
      eligible: true,
    },
    {
      appId: "wiki",
      name: "Wiki",
      removedAt: "2026-10-16T09:19:49.000Z",
      database: "app_wiki",
      backup: { ...BACKUP, path: "/var/backups/wiki.dump", sizeBytes: 900, sha256: "ff".repeat(32) },
      purgeAfter: "2026-11-15T09:19:49.000Z",
      purgedAt: null,
      eligible: false,
    },
    {
      appId: "plain",
      name: "Plain",
      removedAt: "2026-10-10T00:00:00.000Z",
      database: null,
      backup: null,
      purgeAfter: null,
      purgedAt: null,
      eligible: false,
    },
  ];

  it("lists removed apps as a table with backup and purge info", async () => {
    const fetchImpl = reply(200, { apps: entries });
    const r = await retentionCommand(["retention"], workspace(), ENV, fetchImpl, pipe());
    expect(r?.ok).toBe(true);
    const [url, init] = call(fetchImpl);
    expect(url).toBe("http://localhost:4020/admin/v1/retention");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(r!.lines).toEqual([
      "App    Removed               Backup (size, sha256)  Purge after           Status",
      "notes  2026-09-01 08:00 UTC  5.3 MiB abcdef012345…  2026-10-01 08:00 UTC  eligible",
      "wiki   2026-10-16 09:19 UTC  900 B ffffffffffff…    2026-11-15 09:19 UTC  kept",
      "plain  2026-10-10 00:00 UTC  –                      –                     no database",
      "",
      "Backups:",
      `  notes  ${BACKUP.path}`,
      "  wiki  /var/backups/wiki.dump",
      "",
      "Purge one with `platform app purge <id>`.",
    ]);
  });

  it("--eligible asks core-api for the due ones only; an empty list says so", async () => {
    const fetchImpl = reply(200, { apps: [] });
    const r = await retentionCommand(["retention", "--eligible"], workspace(), ENV, fetchImpl, pipe());
    expect(call(fetchImpl)[0]).toBe("http://localhost:4020/admin/v1/retention?eligible=true");
    expect(r).toEqual({ ok: true, lines: ["No removed app can be purged now."] });
    expect((await retentionCommand(["retention"], workspace(), ENV, reply(200, { apps: [] }), pipe()))?.lines).toEqual([
      "No removed apps.",
    ]);
  });

  it("surfaces core-api's error", async () => {
    const r = await retentionCommand(["retention"], workspace(), ENV, reply(401, { error: "unauthorized" }), pipe());
    expect(r).toEqual({ ok: false, lines: ["core-api didn't accept the admin token (CORE_API_ADMIN_TOKEN)."] });
  });
});
