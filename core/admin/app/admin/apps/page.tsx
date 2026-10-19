import Link from "next/link";
import { BackupCheck } from "@/components/BackupCheck";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EventsWarning } from "@/components/EventsWarning";
import { Flash } from "@/components/Flash";
import { VERIFY_PARAM, backupVerdicts, hasCheckableBackup, wantsBackupCheck, type BackupVerdict } from "@/lib/backups";
import { CoreApiError, coreApi, type AdminApp } from "@/lib/core-api";
import { requireAdmin } from "@/lib/session";
import { formatTime } from "@/lib/util";
import { activateApp, deactivateApp, purgeApp, removeApp } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Apps · Admin · ASafariM OS" };

function installStatus(app: AdminApp): string {
  if (app.system) return "Built in";
  if (app.state === "removed") return "Removed · install it again with the CLI";
  if (app.registered_at) return `Installed · registered ${formatTime(app.registered_at)}`;
  return "Installed · waiting for the app to register";
}

/** 12.3 MB */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * A removed app's database: its backup, and when it may be (or was) purged. With `?verify=1`, also
 * whether the backup file is still intact (`verdict`; absent when the check didn't run or said nothing).
 */
function RetentionInfo({ app, verdict }: { app: AdminApp; verdict?: BackupVerdict }) {
  const r = app.retention;
  if (app.state !== "removed" || !r) return null;
  if (!r.database) return <div className="muted">No database: nothing to back up or purge.</div>;
  return (
    <div className="muted" data-testid={`retention-${app.id}`}>
      {r.backup ? (
        <div>
          Backup {formatBytes(r.backup.sizeBytes)}, {formatTime(r.backup.createdAt)}:{" "}
          <span className="mono">{r.backup.path}</span>
          <div className="mono" title="sha256">
            sha256 {r.backup.sha256.slice(0, 16)}…
          </div>
          {verdict ? <BackupCheck appId={app.id} verdict={verdict} purged={!!r.purgedAt} /> : null}
        </div>
      ) : (
        <div>No backup recorded: the database is kept and can&apos;t be purged.</div>
      )}
      {r.purgedAt ? (
        <div>Database purged {formatTime(r.purgedAt)}</div>
      ) : r.purgeAfter ? (
        <div>
          {r.eligible ? "Can be purged since" : "Database kept until"} {formatTime(r.purgeAfter)}
        </div>
      ) : null}
    </div>
  );
}

/** The Purge button: a removed app whose database is kept and backed up. Before purge_after it forces. */
function PurgeAction({ app }: { app: AdminApp }) {
  const r = app.retention;
  if (!r || !r.database || !r.backup || r.purgedAt) return <span className="muted">None</span>;
  const early = !r.eligible;
  return (
    <ConfirmDialog
      triggerLabel={early ? "Purge early" : "Purge"}
      triggerAriaLabel={`Purge ${app.name}`}
      title={`Purge ${app.name}'s database?`}
      description={
        `The database ${r.database} and its login role are dropped. core-api first checks that the backup ` +
        `${r.backup.path} is still there and unchanged; after the purge, that file is the only copy of the data. ` +
        (early && r.purgeAfter
          ? `Its retention window isn't over (it ends ${formatTime(r.purgeAfter)}): this purges it early. `
          : "") +
        "This can't be undone."
      }
      confirmLabel="Purge"
      danger
      typeToConfirm={app.id}
      action={purgeApp}
      fields={{ app: app.id, next: "/admin/apps", ...(early ? { force: "true" } : {}) }}
    />
  );
}

export default async function AppsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const admin = await requireAdmin();
  const params = await searchParams;
  const { notice, error } = params;
  const api = coreApi(admin.idToken);
  const apps = await api.apps();

  // The backup check (#168) runs only when asked for (`?verify=1`): it hashes every backup file.
  // A refusal or an unreachable core-api is one line; the rest of the page still renders.
  const checkable = hasCheckableBackup(apps);
  const checking = checkable && wantsBackupCheck(params[VERIFY_PARAM]);
  let verdicts = new Map<string, BackupVerdict>();
  let checkError: string | null = null;
  if (checking) {
    try {
      verdicts = backupVerdicts(await api.verifyBackups());
    } catch (e) {
      checkError = e instanceof CoreApiError ? e.message : "core-api didn't answer the backup check.";
    }
  }

  return (
    <>
      <h2>Apps</h2>
      <p className="muted">
        Activating an app serves it at its address and puts it in launchers; deactivating shows the &quot;temporarily
        unavailable&quot; page instead. Data is kept either way. Removing an installed or inactive app first backs up
        its database, then revokes its credentials and grants and deletes its event stream and consumers; the database
        is kept until it is purged, after the retention window.
      </p>
      <Flash notice={notice} error={error} />
      {checkable ? (
        <p className="muted" data-testid="backup-check-bar">
          {checking && !checkError ? (
            <>
              Each removed app&apos;s backup file was just checked against the sha256 recorded at Remove.{" "}
              <Link href="/admin/apps">Hide the check</Link>
            </>
          ) : (
            <>
              <Link href={`/admin/apps?${VERIFY_PARAM}=1`} data-testid="check-backups">
                Check backups
              </Link>
              : core-api checks each removed app&apos;s backup file against the sha256 recorded at Remove. It only
              reads, but a large backup takes a while.
            </>
          )}
        </p>
      ) : null}
      {checkError ? (
        <div className="notice bad" role="alert" data-testid="backup-check-error">
          The backup check failed: {checkError}
        </div>
      ) : null}
      <div className="table-wrap">
        <table>
          <caption>Every app core-api knows, with its state</caption>
          <thead>
            <tr>
              <th scope="col">App</th>
              <th scope="col">State</th>
              <th scope="col">Install status</th>
              <th scope="col">Declares</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((app) => (
              <tr key={app.id} data-testid={`app-${app.id}`}>
                <th scope="row">
                  {app.name}
                  <div className="muted mono">
                    {app.id} · v{app.version}
                  </div>
                </th>
                <td>
                  <span className={`badge ${app.state}`} data-testid={`state-${app.id}`}>
                    {app.state}
                  </span>
                </td>
                <td>
                  {installStatus(app)}
                  <RetentionInfo app={app} verdict={verdicts.get(app.id)} />
                  <EventsWarning appId={app.id} types={app.waitingForPublisher ?? []} />
                </td>
                <td className="muted">
                  {app.permissions} permission{app.permissions === 1 ? "" : "s"}, {app.roles} role
                  {app.roles === 1 ? "" : "s"}
                  <div>
                    <Link
                      href={`/admin/events?app=${encodeURIComponent(app.id)}`}
                      aria-label={`Events of ${app.name}`}
                      data-testid={`events-link-${app.id}`}
                    >
                      Events
                    </Link>
                  </div>
                </td>
                <td>
                  {app.system ? (
                    <span className="muted">Always active</span>
                  ) : app.state === "removed" ? (
                    <PurgeAction app={app} />
                  ) : app.state === "active" ? (
                    <ConfirmDialog
                      triggerLabel="Deactivate"
                      triggerAriaLabel={`Deactivate ${app.name}`}
                      title={`Deactivate ${app.name}?`}
                      description={`${app.name} will show the "temporarily unavailable" page at its address and disappear from launchers. Its data is kept, and you can activate it again.`}
                      confirmLabel="Deactivate"
                      danger
                      action={deactivateApp}
                      fields={{ app: app.id, next: "/admin/apps" }}
                    />
                  ) : (
                    <div className="actions-cell">
                      <ConfirmDialog
                        triggerLabel="Activate"
                        triggerAriaLabel={`Activate ${app.name}`}
                        title={`Activate ${app.name}?`}
                        description={`${app.name} will be served at its address and appear in the launchers of people who hold one of its roles. Registering it didn't grant anyone anything: that's still done under Roles & grants.`}
                        confirmLabel="Activate"
                        action={activateApp}
                        fields={{ app: app.id, next: "/admin/apps" }}
                      />
                      <ConfirmDialog
                        triggerLabel="Remove"
                        triggerAriaLabel={`Remove ${app.name}`}
                        title={`Remove ${app.name}?`}
                        description={`${app.name} can no longer register, get tokens or use the event bus: its credentials are revoked, every grant of its roles is deleted, and its event stream (with any events not yet delivered) and its consumers are deleted. Apps subscribed to its events wait for a publisher again. Its database is backed up first (if that fails, nothing is removed) and kept until it is purged after the retention window; installing it again before then keeps its data. This can't be undone.`}
                        confirmLabel="Remove"
                        danger
                        typeToConfirm={app.id}
                        action={removeApp}
                        fields={{ app: app.id, next: "/admin/apps" }}
                      />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
