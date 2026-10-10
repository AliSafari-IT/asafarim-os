import Link from "next/link";
import type { AppStatus } from "@/lib/core-api";
import { coreApi } from "@/lib/core-api";
import { requireAdmin } from "@/lib/session";
import { PROBE_LABEL, formatLatency, overall, problemText, summary } from "@/lib/status";
import { formatTime } from "@/lib/util";

export const dynamic = "force-dynamic";
export const metadata = { title: "Status · Admin · ASafariM OS" };

function Probe({ id, kind, value }: { id: string; kind: "live" | "ready"; value: AppStatus["live"] }) {
  return (
    <span className={`badge ${value}`} data-testid={`${kind}-${id}`}>
      {PROBE_LABEL[value]}
    </span>
  );
}

export default async function StatusPage() {
  const admin = await requireAdmin();
  const report = await coreApi(admin.idToken).status();
  const counts = summary(report.apps);

  return (
    <>
      <h2>Status</h2>
      <p className="muted">
        Each active app&apos;s <strong>live</strong> and <strong>ready</strong> endpoints, from its manifest, as
        core-api last checked them
        {report.intervalMs ? ` (every ${Math.round(report.intervalMs / 1000)} s)` : ""}. Installed and inactive apps
        aren&apos;t polled.
      </p>
      <div className="card row">
        <p data-testid="status-summary" style={{ margin: 0 }}>
          <strong>
            {counts.up} of {counts.polled}
          </strong>{" "}
          polled service{counts.polled === 1 ? "" : "s"} up
          {counts.notPolled > 0 ? `, ${counts.notPolled} not polled` : ""}.{" "}
          <span className="muted">
            {report.checkedAt ? `Checked ${formatTime(report.checkedAt)}.` : "Not checked yet."}
          </span>
        </p>
        <Link href="/admin/status" className="link" data-testid="status-refresh">
          Refresh
        </Link>
      </div>

      {report.apps.length === 0 ? (
        <p className="muted" data-testid="status-empty">
          Nothing to show yet: core-api runs its first check when it starts.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption>Health of core-api and every installed app</caption>
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col">State</th>
                <th scope="col">Live</th>
                <th scope="col">Ready</th>
                <th scope="col">Latency</th>
                <th scope="col">Last checked</th>
                <th scope="col">Since</th>
                <th scope="col">Problem</th>
              </tr>
            </thead>
            <tbody>
              {report.apps.map((a) => {
                const problem = problemText(a);
                return (
                  <tr key={a.id} data-testid={`status-${a.id}`} data-overall={overall(a)}>
                    <th scope="row">
                      {a.name} <span className="muted mono">{a.id}</span>
                    </th>
                    <td>
                      <span className={`badge ${a.state}`}>{a.state}</span>
                    </td>
                    {a.polled ? (
                      <>
                        <td>
                          <Probe id={a.id} kind="live" value={a.live} />
                        </td>
                        <td>
                          <Probe id={a.id} kind="ready" value={a.ready} />
                        </td>
                      </>
                    ) : (
                      <td colSpan={2} className="muted" data-testid={`not-polled-${a.id}`}>
                        Not polled
                      </td>
                    )}
                    <td className="mono">{formatLatency(a.latencyMs)}</td>
                    <td>{a.checkedAt ? formatTime(a.checkedAt) : <span className="muted">–</span>}</td>
                    <td>{formatTime(a.since)}</td>
                    <td data-testid={`problem-${a.id}`}>
                      {problem ? (
                        <>
                          {problem} <span className="muted mono">({a.error})</span>
                        </>
                      ) : (
                        <span className="muted">None</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
