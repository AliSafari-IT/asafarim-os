/**
 * Flow's settings (the `settings` table, one row per key, edited on the Settings page):
 *
 * - `egress_hosts`: the hosts webhook out may call ("host" or "host:port"; lib/egress/hosts.ts);
 * - `email_recipients`: who email may go to, an address or a whole "@domain";
 * - `paused_all`: the kill switch. While it is on no new run starts (the engine asks isPausedAll), no
 *   request is published for a run under way (approving, retrying, a wait that ends) and no outbound
 *   call is made (lib/egress). A stored value that isn't a boolean counts as on;
 * - `ai_generation`: whether a draft may be generated from an issue with AI (#283; lib/generate). It
 *   sends the issue's text to an outside AI provider, so an admin turns it on knowingly.
 *
 * A key that has no row yet has its default: empty lists, not paused, AI drafting off.
 */
import type { Queryable } from "@asafarim/app-sdk/events";
import type { AuditEntry } from "./audit";
import { parseHostEntry } from "./egress/hosts";

export type { Queryable };

/** The rows of a query on a pool, a client or the engine's transaction. */
export async function rowsOf(q: Queryable, text: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
  return ((await q.query(text, values)) as { rows: Record<string, unknown>[] }).rows;
}

export interface Settings {
  egressHosts: string[];
  emailRecipients: string[];
  pausedAll: boolean;
  aiGeneration: boolean;
}

export const LIST_MAX = 100;

const DEFAULTS: Settings = { egressHosts: [], emailRecipients: [], pausedAll: false, aiGeneration: false };

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

export async function getSettings(q: Queryable): Promise<Settings> {
  const rows = await rowsOf(q, "SELECT key, value FROM settings");
  const s = { ...DEFAULTS };
  for (const r of rows as { key: string; value: unknown }[]) {
    if (r.key === "egress_hosts") s.egressHosts = strings(r.value);
    if (r.key === "email_recipients") s.emailRecipients = strings(r.value);
    if (r.key === "paused_all") s.pausedAll = pausedFrom(r.value);
    if (r.key === "ai_generation") s.aiGeneration = r.value === true;
  }
  return s;
}

/**
 * The kill switch as stored: `true` is on, `false` off. Anything else is a malformed row and fails
 * closed: the switch counts as on (and `log`, when given, hears about it), because a switch that
 * can't be read must not be taken for "off".
 */
export function pausedFrom(
  value: unknown,
  log?: { warn(msg: string, fields?: Record<string, unknown>): void },
): boolean {
  if (value === false) return false;
  if (value !== true) {
    log?.warn("flow.settings.paused_all_malformed", { storedType: value === null ? "null" : typeof value });
  }
  return true;
}

/** Whether the kill switch is on. No row: off. A row that isn't a boolean: on (see `pausedFrom`). */
export async function isPausedAll(
  q: Queryable,
  log?: { warn(msg: string, fields?: Record<string, unknown>): void },
): Promise<boolean> {
  const rows = await rowsOf(q, "SELECT value FROM settings WHERE key = 'paused_all'");
  const row = rows[0] as { value?: unknown } | undefined;
  return row === undefined ? false : pausedFrom(row.value, log);
}

/** The entries as typed: comma-, space- or line-separated, trimmed, lower case, each once. */
const entriesOf = (raw: string) => [
  ...new Set(
    raw
      .split(/[,\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  ),
];

const EMAIL =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const DOMAIN = /^@(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export type ListParse = { ok: true; entries: string[] } | { ok: false; error: "invalid_entries" | "too_many_entries" };

export function parseEgressHosts(raw: string): ListParse {
  const entries = entriesOf(raw);
  if (entries.length > LIST_MAX) return { ok: false, error: "too_many_entries" };
  if (entries.some((e) => !parseHostEntry(e))) return { ok: false, error: "invalid_entries" };
  return { ok: true, entries };
}

export function parseEmailRecipients(raw: string): ListParse {
  const entries = entriesOf(raw);
  if (entries.length > LIST_MAX) return { ok: false, error: "too_many_entries" };
  if (entries.some((e) => !EMAIL.test(e) && !DOMAIN.test(e))) return { ok: false, error: "invalid_entries" };
  return { ok: true, entries };
}

/** Whether `address` is on the recipients list (the address itself, or its domain). */
export function isRecipientAllowed(recipients: readonly string[], address: string): boolean {
  const a = address.trim().toLowerCase();
  if (!EMAIL.test(a)) return false;
  return recipients.includes(a) || recipients.includes(`@${a.slice(a.lastIndexOf("@") + 1)}`);
}

type Key = "egress_hosts" | "email_recipients" | "paused_all" | "ai_generation";

async function put(q: Queryable, key: Key, value: unknown, actor: string) {
  await q.query(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), actor],
  );
}

/** Replace one allow-list; the audit entry names the setting and how many entries it holds now. */
export async function setList(
  q: Queryable,
  key: "egress_hosts" | "email_recipients",
  entries: string[],
  actor: string,
): Promise<{ audits: AuditEntry[] }> {
  await put(q, key, entries, actor);
  return { audits: [{ action: "flow.settings.changed", setting: key, count: entries.length, actor }] };
}

/** Turn the kill switch on or off. */
export async function setPausedAll(q: Queryable, on: boolean, actor: string): Promise<{ audits: AuditEntry[] }> {
  await put(q, "paused_all", on, actor);
  return { audits: [{ action: on ? "flow.all.paused" : "flow.all.resumed", actor }] };
}

/** Turn AI drafting from an issue on or off (#283). */
export async function setAiGeneration(q: Queryable, on: boolean, actor: string): Promise<{ audits: AuditEntry[] }> {
  await put(q, "ai_generation", on, actor);
  return { audits: [{ action: "flow.settings.changed", setting: "ai_generation", enabled: on, actor }] };
}

/** What the engine does with a trigger while the kill switch is on: log it, audit it, start nothing. */
export function pausedAllRefusal(
  log: { warn(msg: string, fields?: Record<string, unknown>): void },
  event: { id: string; type: string },
): AuditEntry[] {
  log.warn("flow.trigger.paused_all", { eventId: event.id, type: event.type });
  return [{ action: "flow.run.refused", triggerEventId: event.id, errorCode: "paused_all" }];
}
