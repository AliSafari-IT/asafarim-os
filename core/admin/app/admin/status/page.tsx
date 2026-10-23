import Link from "next/link";
import { When } from "@/components/Cells";
import type { AppStatus } from "@/lib/core-api";
import { coreApi } from "@/lib/core-api";
import { requireAdmin } from "@/lib/session";
import { NO_ALERTS, PROBE_LABEL, alertsNote, formatLatency, overall, problemText, summary } from "@/lib/status";
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
  const api = coreApi(admin.idToken);
  // The alert history never breaks the board: if it can't be loaded (an older core-api, or one that
  // can't answer), the page says so instead of showing an empty history.
  const [report, loaded] = await Promise.all([
    api.status(),
    api.alerts().then(
      (h) => ({ history: h, failed: false }),
      () => ({ history: NO_ALERTS, failed: true }),
    ),
  ]);
  const history = loaded.history;
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
        <div className="table-wrap os-table-wrap">
          <table className="os-table os-table--stack">
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
                    <td data-label="State">
                      <span className={`badge ${a.state}`}>{a.state}</span>
                    </td>
                    {a.polled ? (
                      <>
                        <td data-label="Live">
                          <Probe id={a.id} kind="live" value={a.live} />
                        </td>
                        <td data-label="Ready">
                          <Probe id={a.id} kind="ready" value={a.ready} />
                        </td>
                      </>
                    ) : (
                      <td colSpan={2} className="muted" data-label="Live, ready" data-testid={`not-polled-${a.id}`}>
                        Not polled
                      </td>
                    )}
                    <td className="mono os-nowrap" data-label="Latency">
                      {formatLatency(a.latencyMs)}
                    </td>
                    <td data-label="Last checked">
                      {a.checkedAt ? <When iso={a.checkedAt} /> : <span className="muted">–</span>}
                    </td>
                    <td data-label="Since">
                      <When iso={a.since} />
                    </td>
                    <td data-label="Problem" data-testid={`problem-${a.id}`}>
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

      <h3 id="recent-alerts">Recent alerts</h3>
      {loaded.failed ? (
        <p className="muted" data-testid="alerts-unavailable">
          Alert history couldn&apos;t be loaded from core-api. Use Refresh to try again.
        </p>
      ) : (
        <p className="muted" data-testid="alerts-note">
          {alertsNote(history)}
        </p>
      )}
      {loaded.failed ? null : history.alerts.length === 0 ? (
        <p className="muted" data-testid="alerts-empty">
          No app has gone down or recovered since core-api started.
        </p>
      ) : (
        <div className="table-wrap os-table-wrap">
          <table className="os-table os-table--stack" aria-labelledby="recent-alerts" data-testid="alerts">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">What</th>
                <th scope="col">App</th>
                <th scope="col">Live</th>
                <th scope="col">Ready</th>
                <th scope="col">Problem</th>
              </tr>
            </thead>
            <tbody>
              {history.alerts.map((a, i) => {
                const problem = problemText(a);
                return (
                  <tr key={`${a.at}-${a.id}-${a.kind}-${i}`} data-testid={`alert-${a.id}`} data-kind={a.kind}>
                    <td data-label="When">
                      <When iso={a.at} />
                    </td>
                    <td data-label="What">
                      <span className={`badge ${a.kind === "down" ? "down" : "up"}`}>
                        {a.kind === "down" ? "Down" : "Recovered"}
                      </span>
                    </td>
                    <th scope="row">
                      {a.name} <span className="muted mono">{a.id}</span>
                    </th>
                    <td data-label="Live">{PROBE_LABEL[a.live]}</td>
                    <td data-label="Ready">{PROBE_LABEL[a.ready]}</td>
                    <td data-label="Problem">
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
