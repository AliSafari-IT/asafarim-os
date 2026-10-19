import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupCheck } from "../components/BackupCheck";
import {
  backupVerdicts,
  describeBackupCheck,
  hasCheckableBackup,
  wantsBackupCheck,
  type BackupVerdict,
} from "../lib/backups";
import { BACKUP_CHECK_TIMEOUT_MS, CoreApiError, coreApi, type Retention } from "../lib/core-api";

afterEach(() => vi.unstubAllGlobals());

const backup = { id: 1, path: "/backups/tasks.dump", sizeBytes: 10, sha256: "a".repeat(64), createdAt: "x" };
const retention = (over: Partial<Retention> = {}): Retention => ({
  removedAt: "2026-10-01T00:00:00Z",
  database: "app_tasks",
  backup,
  purgeAfter: "2026-10-31T00:00:00Z",
  purgedAt: null,
  eligible: false,
  ...over,
});

describe("the backup check on the Apps page (#168's ?verify=true)", () => {
  it("runs only for ?verify=1", () => {
    expect(wantsBackupCheck("1")).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", "1 "]) expect(wantsBackupCheck(v)).toBe(false);
  });

  it("is offered only when a removed app has a recorded backup", () => {
    expect(hasCheckableBackup([])).toBe(false);
    expect(hasCheckableBackup([{ state: "active", retention: null }])).toBe(false);
    expect(hasCheckableBackup([{ state: "removed", retention: retention({ database: null, backup: null }) }])).toBe(
      false,
    );
    expect(hasCheckableBackup([{ state: "removed", retention: retention({ backup: null }) }])).toBe(false);
    expect(hasCheckableBackup([{ state: "removed" }])).toBe(false);
    expect(
      hasCheckableBackup([
        { state: "active", retention: null },
        { state: "removed", retention: retention() },
      ]),
    ).toBe(true);
    // A purged app's backup is the only copy left: it is still worth checking.
    expect(hasCheckableBackup([{ state: "removed", retention: retention({ purgedAt: "y" }) }])).toBe(true);
  });

  it("reads each app's verdict from core-api's reply", () => {
    const v = backupVerdicts({
      apps: [
        { appId: "tasks", backupCheck: "ok" },
        { appId: "crm", backupCheck: "missing" },
        { appId: "billing", backupCheck: "mismatch" },
        { appId: "wiki", backupCheck: "unreadable" },
        { appId: "nodb", backupCheck: null },
      ],
    });
    expect([...v]).toEqual([
      ["tasks", "ok"],
      ["crm", "missing"],
      ["billing", "mismatch"],
      ["wiki", "unreadable"],
    ]);
  });

  it("leaves out what it can't read, never guessing a verdict", () => {
    for (const reply of [null, undefined, "x", 3, {}, { apps: "x" }, { apps: null }])
      expect(backupVerdicts(reply).size).toBe(0);
    const v = backupVerdicts({
      apps: [
        null,
        "tasks",
        { backupCheck: "ok" },
        { appId: 7, backupCheck: "ok" },
        { appId: "a", backupCheck: "OK" },
        { appId: "b", backupCheck: "deleted" },
        { appId: "c" },
        { appId: "d", backupCheck: "ok" },
      ],
    });
    expect([...v]).toEqual([["d", "ok"]]);
  });

  it("words each verdict, and says when the purge would be refused", () => {
    expect(describeBackupCheck("ok", false)).toMatchObject({ badge: "up", label: "Backup intact" });
    const missing = describeBackupCheck("missing", false);
    expect(missing).toMatchObject({ badge: "down", label: "Backup missing" });
    expect(missing.text).toContain("refuses to purge");
    const changed = describeBackupCheck("mismatch", false);
    expect(changed).toMatchObject({ badge: "down", label: "Backup changed" });
    expect(changed.text).toContain("refuses to purge");
    expect(describeBackupCheck("unreadable", false)).toMatchObject({ badge: "warn", label: "Backup unreadable" });
  });

  it("after a purge, says the backup is the only copy instead of mentioning a purge", () => {
    for (const v of ["missing", "mismatch", "unreadable"] as BackupVerdict[]) {
      const { text } = describeBackupCheck(v, true);
      expect(text).toContain("only copy of the data");
      expect(text).not.toContain("refuses to purge");
    }
    expect(describeBackupCheck("ok", true).text).not.toContain("only copy");
  });

  it("renders a badge and a sentence per app", () => {
    const html = renderToStaticMarkup(
      createElement(BackupCheck, { appId: "tasks", verdict: "mismatch", purged: false }),
    );
    expect(html).toContain('data-testid="backup-check-tasks"');
    expect(html).toContain('<span class="badge down">Backup changed</span>');
    expect(html).toContain("sha256 no longer matches");
    const ok = renderToStaticMarkup(createElement(BackupCheck, { appId: "crm", verdict: "ok", purged: true }));
    expect(ok).toContain('<span class="badge up">Backup intact</span>');
  });

  it("asks core-api with GET /admin/v1/retention?verify=true as the administrator", async () => {
    process.env.CORE_API_URL = "http://core.test";
    const reply = { apps: [{ appId: "tasks", backupCheck: "ok" }] };
    const fn = vi.fn(async () => new Response(JSON.stringify(reply), { status: 200 }));
    vi.stubGlobal("fetch", fn);
    expect(backupVerdicts(await coreApi("id.jwt").verifyBackups()).get("tasks")).toBe("ok");
    const [url, init] = fn.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(url).toBe("http://core.test/admin/v1/retention?verify=true");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer id.jwt");
    expect(init.cache).toBe("no-store");
  });

  it("passes core-api's refusal on (e.g. verification not configured) for the page's one line", async () => {
    process.env.CORE_API_URL = "http://core.test";
    const body = { error: "bad_request", message: "backup verification isn't configured" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 400 })),
    );
    const err = await coreApi("t")
      .verifyBackups()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreApiError);
    expect(err).toMatchObject({ status: 400, code: "bad_request", message: "backup verification isn't configured" });
  });

  it("gives the check longer than other calls (it hashes every backup), and says so when it runs out", async () => {
    process.env.CORE_API_URL = "http://core.test";
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }),
    );
    const err = await coreApi("t")
      .verifyBackups()
      .catch((e: unknown) => e);
    expect(timeout).toHaveBeenLastCalledWith(BACKUP_CHECK_TIMEOUT_MS);
    expect(BACKUP_CHECK_TIMEOUT_MS).toBeGreaterThan(8000);
    expect(err).toMatchObject({ status: 0, code: "timeout", message: "core-api didn't answer within 60 s." });
    await coreApi("t")
      .apps()
      .catch(() => {});
    expect(timeout).toHaveBeenLastCalledWith(8000);
    timeout.mockRestore();
  });
});
