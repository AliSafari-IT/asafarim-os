/**
 * `platform audit`: core-api's audit log from the command line, the same data as Admin's Audit page.
 *
 *   platform audit [--app <id>] [--actor <text>] [--limit <n>] [--before <event id>] [--json]
 *                          newest first (GET /admin/v1/audit); --actor matches part of the actor, any case;
 *                          --limit is 1–200 (core-api's default is 50); --before pages back from an event id;
 *                          --json prints core-api's reply unchanged
 *
 * Read-only. It talks to the admin API as `platform status` does (`adminEndpoint`: CORE_API_URL and
 * CORE_API_ADMIN_TOKEN, falling back to `.dev/core-api.env` locally). Exit code 0 when core-api answered,
 * 1 when it can't be asked, refuses, or answers with something that isn't an audit page.
 */
import { adminEndpoint } from "./app.ts";
import { commonRefusal, formatDate, request } from "./retention.ts";
import { clean } from "./status.ts";

type Result = { ok: boolean; lines: string[]; stdout?: boolean };

export interface AuditArgs {
  app?: string;
  actor?: string;
  limit?: number;
  before?: number;
  json: boolean;
}

/** Whole numbers only, as core-api checks them (`^\d{1,12}$`). */
const WHOLE = /^\d{1,12}$/;

/** `audit …` (the words after `audit`); null = not valid (the usage is printed). Each option at most once. */
export function parseAuditArgs(args: string[]): AuditArgs | null {
  const p: AuditArgs = { json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = args[i + 1];
    if (a === "--json" && !p.json) p.json = true;
    else if (a === "--app" && p.app === undefined && value && !value.startsWith("--")) p.app = args[++i]!;
    else if (a === "--actor" && p.actor === undefined && value && !value.startsWith("--")) {
      if (value.length > 128) return null;
      p.actor = args[++i]!;
    } else if (a === "--limit" && p.limit === undefined && value && WHOLE.test(value)) {
      const n = Number(args[++i]);
      if (n < 1 || n > 200) return null;
      p.limit = n;
    } else if (a === "--before" && p.before === undefined && value && WHOLE.test(value)) {
      p.before = Number(args[++i]);
    } else return null;
  }
  return p;
}

/** The route with the filters given, in a fixed order (Admin's order: app, actor, before, limit). */
export function auditRoute(p: AuditArgs): string {
  const q = new URLSearchParams();
  if (p.app !== undefined) q.set("app", p.app);
  if (p.actor !== undefined) q.set("actor", p.actor);
  if (p.before !== undefined) q.set("before", String(p.before));
  if (p.limit !== undefined) q.set("limit", String(p.limit));
  const s = q.toString();
  return s ? `${AUDIT}?${s}` : AUDIT;
}

/** One entry (mirrors core-api's audit rows, core/core-api/src/admin.ts). */
export interface AuditEvent {
  id: number;
  at: string;
  actor: string;
  action: string;
  appId: string | null;
  detail: unknown;
}

export interface AuditPage {
  events: AuditEvent[];
  next: number | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * core-api's reply as a page, or null when it isn't one (no `events` array, or an entry without a
 * numeric id): the command then fails instead of formatting garbage.
 */
export function asPage(out: unknown): AuditPage | null {
  if (!isObject(out) || !Array.isArray(out.events)) return null;
  if (!out.events.every((e) => isObject(e) && typeof e.id === "number" && Number.isFinite(e.id))) return null;
  return {
    events: out.events as unknown as AuditEvent[],
    next: typeof out.next === "number" ? out.next : null,
  };
}

/** The longest detail shown in the table; --json has it all. */
export const DETAIL_MAX = 80;

/** The detail as one short line: compact JSON, control characters replaced, cut at DETAIL_MAX. */
export function formatDetail(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  if (isObject(detail) && Object.keys(detail).length === 0) return "";
  let text: string;
  try {
    text = typeof detail === "string" ? detail : (JSON.stringify(detail) ?? "");
  } catch {
    return "?";
  }
  const line = clean(text);
  return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1)}…` : line;
}

/** Padded columns, the last one not padded (`status`'s and `app retention`'s style). */
function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

/** The filters as words, for the empty-log line and the paging hint. */
function filterArgs(p: AuditArgs): string {
  const words: string[] = [];
  if (p.app !== undefined) words.push(`--app ${clean(p.app)}`);
  if (p.actor !== undefined) words.push(`--actor ${JSON.stringify(clean(p.actor))}`);
  if (p.limit !== undefined) words.push(`--limit ${p.limit}`);
  return words.join(" ");
}

export function formatAudit(page: AuditPage, p: AuditArgs): string[] {
  const filters = filterArgs(p);
  if (page.events.length === 0) {
    const where = p.before !== undefined ? ` before event ${p.before}` : "";
    return [`No audit events${where}${filters ? ` match ${filters}` : ""}.`];
  }
  const rows = page.events.map((e) => [
    String(e.id),
    formatDate(typeof e.at === "string" ? e.at : null),
    clean(e.actor),
    clean(e.action),
    e.appId === null || e.appId === undefined ? "–" : clean(e.appId),
    formatDetail(e.detail),
  ]);
  const lines = table(["Id", "At", "Actor", "Action", "App", "Detail"], rows);
  if (page.next !== null) {
    lines.push("", `Older events: pnpm platform audit ${[filters, `--before ${page.next}`].filter(Boolean).join(" ")}`);
  }
  return lines;
}

/** A refusal: a 404 on this fixed route means core-api lacks it; a 400 names the bad filter. */
function refusal(r: Parameters<typeof commonRefusal>[0]): string[] {
  if (!("unreachable" in r) && r.error === "not_found") return [`core-api has no ${AUDIT}.`];
  return commonRefusal(r, "", "").filter(Boolean);
}

const AUDIT = "/admin/v1/audit";

export async function auditCommand(
  args: string[],
  root: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Result | null> {
  const p = parseAuditArgs(args);
  if (!p) return null;

  const target = adminEndpoint(root, env);
  if ("error" in target) return { ok: false, lines: [target.error] };

  const r = await request(target, "GET", auditRoute(p), fetchImpl);
  if (!r.ok) return { ok: false, lines: refusal(r) };
  const page = asPage(r.out);
  if (!page) return { ok: false, lines: [`core-api's reply to GET ${AUDIT} isn't what this CLI expects.`] };

  if (p.json) return { ok: true, stdout: true, lines: [JSON.stringify(r.out, null, 2)] };
  return { ok: true, stdout: true, lines: formatAudit(page, p) };
}
