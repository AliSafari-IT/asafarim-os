/**
 * The backup check on the Apps page: core-api's `GET /admin/v1/retention?verify=true` (asafarim-os
 * #168) hashes each removed app's backup file against the sha256 recorded at Remove. The console only
 * reads the verdicts; nothing is moved, deleted or recorded.
 */

import type { AdminApp } from "./core-api";

/**
 * core-api's verdict for one backup file (mirrors `BackupVerdict`, core-api src/admin.ts).
 * `unreadable`: the file is there but couldn't be read (e.g. permissions).
 */
export type BackupVerdict = "ok" | "missing" | "mismatch" | "unreadable";

const VERDICTS: readonly string[] = ["ok", "missing", "mismatch", "unreadable"];

/** The query parameter that turns the check on: `/admin/apps?verify=1`. */
export const VERIFY_PARAM = "verify";

/** Only `?verify=1` runs the check: hashing a large dump is not something a page load should do by accident. */
export function wantsBackupCheck(value: string | undefined): boolean {
  return value === "1";
}

/** A removed app with a recorded backup: the only kind the check has anything to say about. */
export function hasCheckableBackup(apps: Pick<AdminApp, "state" | "retention">[]): boolean {
  return apps.some((a) => a.state === "removed" && !!a.retention?.backup);
}

/**
 * The verdicts by app id, read defensively from core-api's reply: an entry without an app id, or with
 * a verdict this console doesn't know, is left out (that app then shows no check, never a wrong one).
 */
export function backupVerdicts(reply: unknown): Map<string, BackupVerdict> {
  const out = new Map<string, BackupVerdict>();
  const apps = (reply as { apps?: unknown } | null)?.apps;
  if (!Array.isArray(apps)) return out;
  for (const e of apps) {
    if (!e || typeof e !== "object") continue;
    const { appId, backupCheck } = e as { appId?: unknown; backupCheck?: unknown };
    if (typeof appId === "string" && typeof backupCheck === "string" && VERDICTS.includes(backupCheck))
      out.set(appId, backupCheck as BackupVerdict);
  }
  return out;
}

/** How a verdict reads on the page: a badge (class and text) and one plain sentence. */
export function describeBackupCheck(
  verdict: BackupVerdict,
  purged: boolean,
): { badge: "up" | "down" | "warn"; label: string; text: string } {
  // After a purge the backup is the only copy of the data, so a bad verdict is worth saying twice.
  const onlyCopy = purged ? " The database was purged, so this file is the only copy of the data." : "";
  switch (verdict) {
    case "ok":
      return { badge: "up", label: "Backup intact", text: "The file is there and its sha256 matches." };
    case "missing":
      return {
        badge: "down",
        label: "Backup missing",
        text: `The file isn't there any more.${purged ? " The database was purged, so this file was the only copy of the data." : " core-api refuses to purge until it is back."}`,
      };
    case "mismatch":
      return {
        badge: "down",
        label: "Backup changed",
        text: `The file's sha256 no longer matches the one recorded at Remove.${purged ? onlyCopy : " core-api refuses to purge it."}`,
      };
    case "unreadable":
      return {
        badge: "warn",
        label: "Backup unreadable",
        text: `The file is there but core-api couldn't read it (check its permissions).${onlyCopy}`,
      };
  }
}
