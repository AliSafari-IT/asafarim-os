/**
 * `platform status` (P6.1 from the command line): core-api's status board and, with `--alerts`, its
 * alert history, the same data as Admin's Status page.
 *
 *   platform status [--alerts] [--json]
 *                          each app's live/ready as last polled (GET /admin/v1/status); --alerts adds the
 *                          last down/recovered transitions (GET /admin/v1/alerts); --json prints the replies
 *
 * Read-only. It talks to the admin API as `platform app retention` does (`adminEndpoint`: CORE_API_URL
 * and CORE_API_ADMIN_TOKEN, falling back to `.dev/core-api.env` locally).
 *
 * Exit code: 0 when core-api has finished a health round and every polled entry (every active app,
 * and core-api itself) is both live and ready; 1 otherwise, or when core-api can't be asked. So a
 * script can wait on it. Apps that aren't active are listed but never fail it.
 */
import { adminEndpoint } from "./app.ts";
import { commonRefusal, formatDate, request } from "./retention.ts";
import { clean } from "./text.ts";

// `clean` lived here first; the other read commands still import it from this module.
export { clean };

type Result = { ok: boolean; lines: string[]; stdout?: boolean };

export interface StatusArgs {
  alerts: boolean;
  json: boolean;
}

/** `status [--alerts] [--json]` (the words after `status`); null = not valid (the usage is printed). */
export function parseStatusArgs(args: string[]): StatusArgs | null {
  const p: StatusArgs = { alerts: false, json: false };
  for (const a of args) {
    if (a === "--alerts" && !p.alerts) p.alerts = true;
    else if (a === "--json" && !p.json) p.json = true;
    else return null;
  }
  return p;
}

type Probe = "up" | "down" | "unknown";

/** One board entry (mirrors core-api's `AppStatus`, core/core-api/src/health.ts). */
export interface AppStatus {
  id: string;
  name: string;
  state: string;
  polled: boolean;
  live: Probe;
  ready: Probe;
  latencyMs: number | null;
  error?: string;
  detail?: string;
  checkedAt: string | null;
  since: string;
}

export interface StatusReport {
  checkedAt: string | null;
  intervalMs: number | null;
  apps: AppStatus[];
}

/** One transition (mirrors core-api's `AlertRecord`, core/core-api/src/alerts.ts). */
export interface AlertRecord {
  at: string;
  kind: "down" | "recovered";
  id: string;
  name: string;
  live: Probe;
  ready: Probe;
  error?: string;
  detail?: string;
}

export interface AlertHistory {
  webhook: boolean;
  downRounds: number | null;
  alerts: AlertRecord[];
}

/** Every polled entry is live and ready, after at least one finished round. */
export function healthy(report: StatusReport): boolean {
  if (!report.checkedAt) return false;
  return report.apps.every((a) => !a.polled || (a.live === "up" && a.ready === "up"));
}

const why = (error: unknown, detail: unknown) =>
  error === undefined ? "" : detail === undefined ? clean(error) : `${clean(error)} (${clean(detail)})`;

/** Padded columns, the last one not padded (the drift report's and `app retention`'s style). */
function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

export function formatStatus(report: StatusReport): string[] {
  if (!report.checkedAt && report.apps.length === 0) {
    return ["core-api hasn't finished a health round yet (or its health poller is off)."];
  }
  const rows = report.apps.map((a) => [
    clean(a.id),
    clean(a.state),
    a.polled ? clean(a.live) : "–",
    a.polled ? clean(a.ready) : "–",
    a.polled && typeof a.latencyMs === "number" ? `${a.latencyMs} ms` : "–",
    a.polled ? formatDate(a.checkedAt) : "not polled",
    why(a.error, a.detail),
  ]);
  const lines = table(["App", "State", "Live", "Ready", "Latency", "Checked", "Error"], rows);
  const down = report.apps.filter((a) => a.polled && !(a.live === "up" && a.ready === "up"));
  const every = typeof report.intervalMs === "number" ? `, every ${Math.round(report.intervalMs / 1000)} s` : "";
  lines.push("", `Last round: ${formatDate(report.checkedAt)}${every}.`);
  if (!report.checkedAt) lines.push("No round has finished yet, so nothing is known to be up.");
  else if (down.length === 0) lines.push("Everything polled is live and ready.");
  else lines.push(`Not live and ready: ${down.map((a) => clean(a.id)).join(", ")}.`);
  return lines;
}

export function formatAlerts(history: AlertHistory): string[] {
  const webhook = history.webhook ? "a webhook is set" : "no webhook is set, so alerts are recorded, not sent";
  const rounds = typeof history.downRounds === "number" ? `; "down" after ${history.downRounds} round(s)` : "";
  const lines = ["", `Recent alerts (${webhook}${rounds}):`];
  if (history.alerts.length === 0) return [...lines, "  none"];
  const rows = history.alerts.map((a) => [
    formatDate(a.at),
    clean(a.kind),
    `${clean(a.id)} (${clean(a.name)})`,
    `live ${clean(a.live)}, ready ${clean(a.ready)}`,
    why(a.error, a.detail),
  ]);
  return [...lines, ...table(["At", "Kind", "App", "Checks", "Error"], rows).map((l) => `  ${l}`)];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * core-api's reply as a board, or null when it isn't one (not an object, or `apps` with an entry
 * that isn't an object with a string id): the command then fails instead of formatting garbage.
 */
export function asReport(out: unknown): StatusReport | null {
  if (!isObject(out) || (out.apps !== undefined && !Array.isArray(out.apps))) return null;
  const apps: unknown[] = Array.isArray(out.apps) ? out.apps : [];
  if (!apps.every((a) => isObject(a) && typeof a.id === "string")) return null;
  return {
    checkedAt: typeof out.checkedAt === "string" ? out.checkedAt : null,
    intervalMs: typeof out.intervalMs === "number" ? out.intervalMs : null,
    apps: apps as unknown as AppStatus[],
  };
}

/** core-api's alert history, or null when it isn't one (the same rule as `asReport`). */
export function asHistory(out: unknown): AlertHistory | null {
  if (!isObject(out) || (out.alerts !== undefined && !Array.isArray(out.alerts))) return null;
  const alerts: unknown[] = Array.isArray(out.alerts) ? out.alerts : [];
  if (!alerts.every((a) => isObject(a) && typeof a.id === "string")) return null;
  return {
    webhook: out.webhook === true,
    downRounds: typeof out.downRounds === "number" ? out.downRounds : null,
    alerts: alerts as unknown as AlertRecord[],
  };
}

/** A refusal on one of the two fixed routes: a 404 means core-api lacks the route, not an app. */
function refusal(r: Parameters<typeof commonRefusal>[0], route: string): string[] {
  if (!("unreachable" in r) && r.error === "not_found") {
    return [`core-api has no ${route} (it may be older than the status board or alert history).`];
  }
  return commonRefusal(r, "", "").filter(Boolean);
}

const malformed = (route: string) => [`core-api's reply to GET ${route} isn't what this CLI expects.`];

const STATUS = "/admin/v1/status";
const ALERTS = "/admin/v1/alerts";

export async function statusCommand(
  args: string[],
  root: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Result | null> {
  const p = parseStatusArgs(args);
  if (!p) return null;

  const target = adminEndpoint(root, env);
  if ("error" in target) return { ok: false, lines: [target.error] };

  const s = await request(target, "GET", STATUS, fetchImpl);
  if (!s.ok) return { ok: false, lines: refusal(s, STATUS) };
  const report = asReport(s.out);
  if (!report) return { ok: false, lines: malformed(STATUS) };

  let alertsOut: Record<string, unknown> | undefined;
  let history: AlertHistory | undefined;
  if (p.alerts) {
    const a = await request(target, "GET", ALERTS, fetchImpl);
    if (!a.ok) return { ok: false, lines: refusal(a, ALERTS) };
    const h = asHistory(a.out);
    if (!h) return { ok: false, lines: malformed(ALERTS) };
    alertsOut = a.out;
    history = h;
  }

  const ok = healthy(report);
  if (p.json) {
    const out = alertsOut ? { status: s.out, alerts: alertsOut } : { status: s.out };
    return { ok, stdout: true, lines: [JSON.stringify(out, null, 2)] };
  }
  return {
    ok,
    stdout: true,
    lines: [...formatStatus(report), ...(history ? formatAlerts(history) : [])],
  };
}
