import Link from "next/link";
import { JsonDetail, ShortId, When } from "@/components/Cells";
import { AuditTabs, ToneBadge } from "@/components/AuditParts";
import { CHANGE_ACTIONS, CHANGE_KINDS, dayAfter, describeChange } from "@/lib/audit";
import { changeFilters, changeQuery } from "@/lib/audit-filters";
import { coreApi } from "@/lib/core-api";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin changes · Audit · Admin · ASafariM OS" };

const PAGE = 25;

export default async function ChangesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const admin = await requireAdmin();
  const f = changeFilters(await searchParams);
  const api = coreApi(admin.idToken);
  const [apps, { events, next }] = await Promise.all([
    api.apps(),
    api.audit({
      ...(f.app ? { app: f.app } : {}),
      ...(f.actor ? { actor: f.actor } : {}),
      ...(f.action ? { action: f.action } : {}),
      ...(f.involving ? { involving: f.involving } : {}),
      ...(f.from ? { since: f.from } : {}),
      ...(f.to ? { until: dayAfter(f.to) } : {}),
      ...(f.before ? { before: f.before } : {}),
      limit: PAGE,
    }),
  ]);
  const filtered = Boolean(f.app || f.actor || f.action || f.involving || f.from || f.to);

  return (
    <>
      <h2>Audit</h2>
      <p className="muted">
        Every change core-api makes on an administrator&apos;s (or an app&apos;s) say-so, newest first. People appear as{" "}
        <code>user:&lt;id&gt;</code>; <code>admin</code> is the command-line token; <code>app:&lt;id&gt;</code> is an
        app registering itself. Times are UTC.
      </p>
      <AuditTabs current="changes" />

      <form method="get" className="card filters" aria-label="Filter admin changes">
        <div>
          <label htmlFor="audit-app">App</label>
          <select id="audit-app" name="app" defaultValue={f.app ?? ""}>
            <option value="">All apps</option>
            <option value="core">The core (core.admin)</option>
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.id})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="audit-action">What</label>
          <select id="audit-action" name="action" defaultValue={f.action ?? ""}>
            <option value="">Everything</option>
            <optgroup label="Kinds">
              {CHANGE_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="One action">
              {CHANGE_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        <div>
          <label htmlFor="audit-actor">Actor contains</label>
          <input
            id="audit-actor"
            name="actor"
            defaultValue={f.actor ?? ""}
            placeholder="e.g. dev-admin"
            maxLength={128}
          />
        </div>
        <div>
          <label htmlFor="audit-involving">About person</label>
          <input
            id="audit-involving"
            name="involving"
            defaultValue={f.involving ?? ""}
            placeholder="a subject id"
            maxLength={128}
          />
        </div>
        <div>
          <label htmlFor="audit-from">From</label>
          <input id="audit-from" name="from" type="date" defaultValue={f.from ?? ""} />
        </div>
        <div>
          <label htmlFor="audit-to">To</label>
          <input id="audit-to" name="to" type="date" defaultValue={f.to ?? ""} />
        </div>
        <div className="filter-actions">
          <button type="submit">Filter</button>
          {filtered ? (
            <Link href="/admin/audit/changes" className="muted">
              Clear
            </Link>
          ) : null}
          <a href={`/admin/audit/export?source=changes&${changeQuery(f)}`} download data-testid="export-changes">
            Export CSV
          </a>
        </div>
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
              {f.app ? ` for ${f.app}` : ""}
              {f.action ? `, ${f.action.endsWith(".") ? `${f.action}*` : f.action}` : ""}
              {f.actor ? ` by actors containing "${f.actor}"` : ""}
              {f.involving ? ` about ${f.involving}` : ""}
            </caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">What happened</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">App</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const d = describeChange(e);
                const subject = typeof e.detail?.subject === "string" ? e.detail.subject : undefined;
                return (
                  <tr key={e.id} data-testid="audit-row">
                    <td data-label="When">
                      <When iso={e.at} />
                    </td>
                    <td className="os-fill" data-label="What happened">
                      <ToneBadge tone={d.tone} label={d.label} /> {d.sentence}
                      {subject ? (
                        <>
                          {" "}
                          <Link
                            href={`/admin/audit/changes?involving=${encodeURIComponent(subject)}`}
                            className="muted"
                          >
                            (all about them)
                          </Link>
                        </>
                      ) : null}
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
                    <td data-label="Detail">
                      <JsonDetail value={e.detail} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {next ? (
        <p>
          <Link href={`/admin/audit/changes?${changeQuery(f, { before: String(next) })}`} rel="next">
            Older events
          </Link>
        </p>
      ) : null}
    </>
  );
}
