import { describeBackupCheck, type BackupVerdict } from "../lib/backups";

/** One removed app's backup check (Apps page, `?verify=1`): a badge and a sentence. */
export function BackupCheck({ appId, verdict, purged }: { appId: string; verdict: BackupVerdict; purged: boolean }) {
  const { badge, label, text } = describeBackupCheck(verdict, purged);
  return (
    <div className="backup-check" data-testid={`backup-check-${appId}`}>
      <span className={`badge ${badge}`}>{label}</span> <span className="muted">{text}</span>
    </div>
  );
}
