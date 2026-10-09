import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EventsWarning } from "@/components/EventsWarning";
import { Flash } from "@/components/Flash";
import { coreApi, type AdminApp } from "@/lib/core-api";
import { requireAdmin } from "@/lib/session";
import { formatTime } from "@/lib/util";
import { activateApp, deactivateApp } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Apps · Admin · ASafariM OS" };

function installStatus(app: AdminApp): string {
  if (app.system) return "Built in";
  if (app.registered_at) return `Installed · registered ${formatTime(app.registered_at)}`;
  return "Installed · waiting for the app to register";
}

export default async function AppsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const admin = await requireAdmin();
  const { notice, error } = await searchParams;
  const apps = await coreApi(admin.idToken).apps();

  return (
    <>
      <h2>Apps</h2>
      <p className="muted">
        Activating an app serves it at its address and puts it in launchers; deactivating shows the &quot;temporarily
        unavailable&quot; page instead. Data is kept either way.
      </p>
      <Flash notice={notice} error={error} />
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
                  <EventsWarning appId={app.id} types={app.waitingForPublisher ?? []} />
                </td>
                <td className="muted">
                  {app.permissions} permission{app.permissions === 1 ? "" : "s"}, {app.roles} role
                  {app.roles === 1 ? "" : "s"}
                </td>
                <td>
                  {app.system ? (
                    <span className="muted">Always active</span>
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
                    <ConfirmDialog
                      triggerLabel="Activate"
                      triggerAriaLabel={`Activate ${app.name}`}
                      title={`Activate ${app.name}?`}
                      description={`${app.name} will be served at its address and appear in the launchers of people who hold one of its roles. Registering it didn't grant anyone anything: that's still done under Roles & grants.`}
                      confirmLabel="Activate"
                      action={activateApp}
                      fields={{ app: app.id, next: "/admin/apps" }}
                    />
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
