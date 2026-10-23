import Link from "next/link";
import { JsonDetail, ShortId, When } from "@/components/Cells";
import { coreApi } from "@/lib/core-api";
import { requireAdmin } from "@/lib/session";
import { isAppId } from "@/lib/util";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit · Admin · ASafariM OS" };

const PAGE = 25;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const admin = await requireAdmin();
  const params = await searchParams;
  const app = isAppId(params.app) ? params.app : undefined;
  const actor = params.actor?.trim().slice(0, 128) || undefined;
  const before = /^\d{1,12}$/.test(params.before ?? "") ? Number(params.before) : undefined;

  const api = coreApi(admin.idToken);
  const [apps, { events, next }] = await Promise.all([api.apps(), api.audit({ app, actor, before, limit: PAGE })]);

  const older = new URLSearchParams();
  if (app) older.set("app", app);
  if (actor) older.set("actor", actor);
  if (next) older.set("before", String(next));

  return (
    <>
      <h2>Audit</h2>
      <p className="muted">
        Every change core-api makes on an administrator&apos;s say-so, newest first. People appear as{" "}
        <code>user:&lt;id&gt;</code>; <code>admin</code> is the command-line token.
      </p>
      <form method="get" className="card row" aria-label="Filter the audit log">
        <div>
          <label htmlFor="audit-app">App</label>
          <select id="audit-app" name="app" defaultValue={app ?? ""}>
            <option value="">All apps</option>
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.id})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="audit-actor">Actor contains</label>
          <input
            id="audit-actor"
            name="actor"
            defaultValue={actor ?? ""}
            placeholder="e.g. dev-admin"
            maxLength={128}
          />
        </div>
        <button type="submit">Filter</button>
        {app || actor ? (
          <Link href="/admin/audit" className="muted">
            Clear
          </Link>
        ) : null}
      </form>

      {events.length === 0 ? (
        <p className="muted" data-testid="audit-empty">
          No events match.
        </p>
      ) : (
        <div className="table-wrap os-table-wrap">
          <table className="os-table os-table--stack">
            <caption>
              {events.length} event{events.length === 1 ? "" : "s"}
              {app ? ` for ${app}` : ""}
              {actor ? ` by actors containing "${actor}"` : ""}
            </caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">App</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} data-testid="audit-row">
                  <td data-label="When">
                    <When iso={e.at} />
                  </td>
                  <td data-label="Actor">
                    <ShortId value={e.actor} testId="audit-actor" />
                  </td>
                  <td className="mono os-nowrap" data-label="Action" data-testid="audit-action">
                    {e.action}
                  </td>
                  <td className="mono" data-label="App">
                    {e.appId ?? "—"}
                  </td>
                  <td className="os-fill" data-label="Detail">
                    <JsonDetail value={e.detail} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next ? (
        <p>
          <Link href={`/admin/audit?${older}`} rel="next">
            Older events
          </Link>
        </p>
      ) : null}
    </>
  );
}
