/**
 * Status alerts (P6.1 follow-up, ADR 0001 §9 "alerts go to the existing Discord deploy channel").
 *
 * The health poller hands every finished round to `observe()`. An entry that is polled and not both
 * live and ready for `downRounds` rounds in a row is **down**: one message says so. When it is live
 * and ready again, one message says it recovered. Nothing else is sent: an app that is deactivated or
 * removed is not an outage (its state is dropped quietly), and a state that holds sends nothing more.
 * Everything that changed in one round goes out together: one webhook call, or several in order when
 * the lines don't fit in one message (no app's line is ever dropped).
 *
 * Off unless `CORE_API_ALERT_WEBHOOK_URL` is set. The URL is a secret (whoever holds it can post),
 * so it is never logged or returned. A message carries only the app id and name, live/ready, the
 * error class and its detail (an HTTP status, a core-api check name or an env var name); never an
 * upstream, a URL or a header. Mentions are disabled. A failed or slow send is logged by status or
 * class and dropped: it never delays a poll round, and nothing is retried.
 *
 * Alert history: every down and recovered transition is also kept in memory (the last 50, newest
 * first) for Admin's Status page, whether or not a webhook is set. It holds the same fields a message
 * does (time, app id and name, live/ready, error class and detail), never a URL, upstream or header,
 * and, with a store (alert-store.ts), it is saved best effort and the newest are loaded again when
 * core-api starts, so it survives a restart. A failed save or load is logged by class and never
 * delays or breaks a poll round.
 *
 * Alerted state across a restart: with a store, an app whose newest saved transition is "down" starts
 * as already alerted. An app still down after a restart gets no second "down" message or history
 * entry, and its "recovered" one still goes out once it is healthy again. Only a "down" from the last
 * `restoreMaxAgeMs` (default 24 h) is restored: the store is best effort, so a lost "recovered" row
 * could otherwise hide a later, separate outage after a restart for as long as it lasts; an older
 * outage that still holds is announced again instead. Known limit: an app that was deactivated or
 * removed while down leaves no row saying so, so if it is active and healthy again after a restart it
 * gets one "recovered".
 */
import { SELF_ID, type AppStatus, type RoundInfo, type StatusReport } from "./health.ts";

export interface AlertConfig {
  webhookUrl: string;
  /** Rounds in a row an entry must be unhealthy before the "down" message; 1 to 20, default 2. */
  downRounds: number;
}

/**
 * CORE_API_ALERT_WEBHOOK_URL (unset or empty = no alerts; otherwise an https URL with no credentials)
 * and CORE_API_ALERT_DOWN_ROUNDS. Errors name the variable, never its value.
 */
export function parseAlertConfig(env: Record<string, string | undefined>): AlertConfig | undefined {
  const raw = env.CORE_API_ALERT_WEBHOOK_URL;
  if (raw === undefined || raw === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("CORE_API_ALERT_WEBHOOK_URL must be an https URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("CORE_API_ALERT_WEBHOOK_URL must be an https URL");
  }
  return { webhookUrl: url.href, downRounds: parseDownRounds(env) };
}

/** CORE_API_ALERT_DOWN_ROUNDS: 1 to 20, default 2. Used by the webhook and the alert history alike. */
export function parseDownRounds(env: Record<string, string | undefined>): number {
  const rounds = env.CORE_API_ALERT_DOWN_ROUNDS;
  if (rounds === undefined || rounds === "") return 2;
  const downRounds = Number(rounds);
  if (!Number.isInteger(downRounds) || downRounds < 1 || downRounds > 20) {
    throw new Error("CORE_API_ALERT_DOWN_ROUNDS must be a whole number from 1 to 20");
  }
  return downRounds;
}

export interface AlerterDeps {
  /** Unset = no webhook: transitions are only kept in the history. */
  webhookUrl?: string;
  /** Rounds in a row an entry must be unhealthy before it counts as down; 1 to 20. */
  downRounds: number;
  /** Transitions kept for Admin; default 50. */
  historySize?: number;
  now?: () => Date;
  fetch?: typeof fetch;
  /** Per webhook call; default 5 s. */
  timeoutMs?: number;
  log?: (line: object) => void;
  /** Where the history is kept across restarts; unset = memory only. */
  store?: AlertStore;
  /** The oldest saved "down" restored as already alerted at start; default 24 h. */
  restoreMaxAgeMs?: number;
}

/** Keeps the alert history across restarts (alert-store.ts has the Postgres one). */
export interface AlertStore {
  /** One round's transitions, in the order the history shows them. */
  save(records: AlertRecord[]): Promise<void>;
  /** The newest `limit` transitions, newest round first. */
  recent(limit: number): Promise<AlertRecord[]>;
  /** The apps whose newest saved transition is "down" (alerted, not yet recovered), with its time. */
  open?(): Promise<{ id: string; at: string }[]>;
}

interface Tracked {
  /** Unhealthy rounds in a row; 0 while healthy. */
  bad: number;
  /** A "down" message went out and no "recovered" yet. */
  alerted: boolean;
}

/** One down or recovered transition, as Admin's Status page shows it. */
export interface AlertRecord {
  at: string;
  kind: "down" | "recovered";
  id: string;
  name: string;
  live: AppStatus["live"];
  ready: AppStatus["ready"];
  error?: string;
  detail?: string;
}

export interface AlertHistory {
  /** Whether a webhook is set (never its URL). */
  webhook: boolean;
  downRounds: number;
  /** Newest first. */
  alerts: AlertRecord[];
}

const DEFAULT_HISTORY = 50;
const DEFAULT_RESTORE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** One line of text, bounded: what the history keeps of an app's own strings. */
const bounded = (text: string, max: number) => {
  const flat = text.replace(/\p{Cc}+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function record(kind: AlertRecord["kind"], a: AppStatus, at: string): AlertRecord {
  return {
    at,
    kind,
    id: bounded(a.id, 64),
    name: bounded(a.name || a.id, 80),
    live: a.live,
    ready: a.ready,
    ...(a.error ? { error: bounded(a.error, 32) } : {}),
    ...(a.detail ? { detail: bounded(a.detail, 64) } : {}),
  };
}

const MAX_CONTENT = 1900; // Discord's limit is 2000 characters

const healthy = (a: AppStatus) => a.live === "up" && a.ready === "up";

/**
 * Text safe inside a Discord message: one line, bounded, with no mention, link or code syntax (`@`, `<`,
 * backticks are dropped) and every other markdown character escaped, so it shows as written.
 */
export function plain(text: string, max = 80): string {
  const flat = text
    .replace(/\p{Cc}+/gu, " ")
    .replace(/[`<@]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return cut.replace(/[\\*_~|>#[\]():]/g, "\\$&");
}

function describe(a: AppStatus): string {
  const label = a.name && a.name !== a.id ? `${plain(a.name)} (${plain(a.id, 64)})` : plain(a.id, 64);
  const why = a.error ? `, ${plain(a.error)}${a.detail ? ` ${plain(a.detail, 64)}` : ""}` : "";
  return `${label}: live ${a.live}, ready ${a.ready}${why}`;
}

const HEADER = "ASafariM OS status";

/**
 * A round's lines as webhook messages, each at most `max` characters. Lines are never cut between
 * messages, so every changed app is in exactly one message; only a single line longer than a whole
 * message is shortened on its own. Later messages say they continue the first.
 */
export function splitMessages(lines: string[], max = MAX_CONTENT): string[] {
  const more = `${HEADER} (continued)`;
  const room = max - more.length - 1; // the longer header, so a line fits under either
  const messages: string[] = [];
  let current = "";
  for (const raw of lines) {
    const line = raw.length > room ? `${raw.slice(0, room - 1)}…` : raw;
    if (current && current.length + 1 + line.length > max) {
      messages.push(current);
      current = "";
    }
    current = current ? `${current}\n${line}` : `${messages.length ? more : HEADER}\n${line}`;
  }
  if (current) messages.push(current);
  return messages;
}

export function createStatusAlerter(deps: AlerterDeps) {
  const fetchFn = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 5000;
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? (() => new Date());
  // A whole number of at least 0, so trimming in observe() can never throw.
  const historySize = Math.max(0, Math.floor(deps.historySize ?? DEFAULT_HISTORY));
  const tracked = new Map<string, Tracked>();
  const sending = new Set<Promise<void>>();
  /** Newest round first (a round's own lines in message order); trimmed to `historySize`. */
  const history: AlertRecord[] = [];
  const store = deps.store;

  /** A store failure, by class only (a pg SQLSTATE or the error's name), never its message. */
  const storeFailed = (msg: string) => (err: unknown) =>
    log({ msg, error: (err as { code?: unknown })?.code ?? (err as Error)?.name ?? "Error" });

  /** Keeps a pending promise in `sending` until it settles, so settled() waits for it. */
  const track = (p: Promise<void>) => {
    const t = p.finally(() => sending.delete(t));
    sending.add(t);
  };

  async function send(webhookUrl: string, content: string) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchFn(webhookUrl, {
        method: "POST",
        redirect: "manual",
        signal: ctl.signal,
        headers: { "content-type": "application/json", "user-agent": "asafarim-core-api-alerts" },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.status < 200 || res.status >= 300) log({ msg: "health.alert_failed", status: res.status });
      else log({ msg: "health.alert_sent" });
    } catch (err) {
      log({ msg: "health.alert_failed", error: ctl.signal.aborted ? "timeout" : (err as Error).name });
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadHistory(from: AlertStore) {
    if (historySize === 0) return;
    try {
      const saved = await from.recent(historySize);
      const oldest = history.at(-1)?.at;
      const older = oldest === undefined ? saved : saved.filter((r) => r.at < oldest);
      history.push(...older.slice(0, historySize - history.length).map((r) => ({ ...r })));
      log({ msg: "health.alert_history_loaded", count: older.length });
    } catch (err) {
      storeFailed("health.alert_history_load_failed")(err);
    }
  }

  async function loadAlerted(from: AlertStore) {
    if (!from.open) return;
    try {
      const open = await from.open();
      const maxAge = Math.max(0, deps.restoreMaxAgeMs ?? DEFAULT_RESTORE_MAX_AGE_MS);
      const cutoff = now().getTime() - maxAge;
      let count = 0;
      for (const { id, at } of open) {
        if (typeof id !== "string" || tracked.has(id)) continue;
        const t = Date.parse(at);
        if (!(t >= cutoff)) continue; // too old (or unreadable): count it from zero, as before
        tracked.set(id, { bad: deps.downRounds, alerted: true });
        count += 1;
      }
      log({ msg: "health.alert_state_loaded", count });
    } catch (err) {
      storeFailed("health.alert_state_load_failed")(err);
    }
  }

  return {
    /**
     * One finished poll round. Never throws, never waits for the webhook. When the round couldn't
     * read the app list, only core-api's own entry is new: the apps' kept results neither count as
     * another bad round nor are forgotten.
     */
    observe(report: StatusReport, round: RoundInfo = { appsChecked: true }) {
      const down: AppStatus[] = [];
      const recovered: AppStatus[] = [];
      const seen = new Set<string>();
      for (const a of report.apps) {
        if (!round.appsChecked && a.id !== SELF_ID) {
          seen.add(a.id); // kept from an earlier round: not checked again, so no change
          continue;
        }
        if (!a.polled) continue; // installed or inactive: not an outage
        seen.add(a.id);
        const t = tracked.get(a.id) ?? { bad: 0, alerted: false };
        if (healthy(a)) {
          if (t.alerted) recovered.push(a);
          tracked.set(a.id, { bad: 0, alerted: false });
          continue;
        }
        t.bad += 1;
        if (!t.alerted && t.bad >= deps.downRounds) {
          t.alerted = true;
          down.push(a);
        }
        tracked.set(a.id, t);
      }
      // Deactivated or removed since the last round: forget it, say nothing.
      for (const id of [...tracked.keys()]) if (!seen.has(id)) tracked.delete(id);

      if (down.length === 0 && recovered.length === 0) return;
      const at = now().toISOString();
      const changes = [...down.map((a) => record("down", a, at)), ...recovered.map((a) => record("recovered", a, at))];
      history.unshift(...changes);
      if (history.length > historySize) history.length = historySize;
      if (store) {
        // Its own copies, and a store that throws instead of rejecting can't break the round either.
        const rows = changes.map((r) => ({ ...r }));
        track(
          Promise.resolve()
            .then(() => store.save(rows))
            .catch(storeFailed("health.alert_store_failed")),
        );
      }

      const webhookUrl = deps.webhookUrl;
      if (!webhookUrl) return;
      const lines = [
        ...down.map((a) => `🔴 Down: ${describe(a)}`),
        ...recovered.map((a) => `🟢 Recovered: ${describe(a)}`),
      ];
      const messages = splitMessages(lines);
      // One after another, so the channel shows them in order; a failed one doesn't stop the rest.
      track(messages.reduce((prev, content) => prev.then(() => send(webhookUrl, content)), Promise.resolve()));
    },
    /**
     * Load what the store kept (once, at start, before polling). Never throws.
     *
     * History: the newest saved transitions. Anything already observed in this process stays on top,
     * and a saved row that is not older than it is left out, so nothing shows twice.
     *
     * Alerted state: each app whose newest saved transition is a "down" within `restoreMaxAgeMs`
     * starts as already alerted, so a restart sends no second "down" for it, and its "recovered" still
     * goes out. An app this process has already seen keeps what it saw.
     */
    async load() {
      if (!store) return;
      await Promise.all([loadHistory(store), loadAlerted(store)]);
    },
    /** The recent transitions for Admin, newest round first (a copy). */
    history(): AlertHistory {
      return {
        webhook: Boolean(deps.webhookUrl),
        downRounds: deps.downRounds,
        alerts: history.map((r) => ({ ...r })),
      };
    },
    /** Wait for the webhook calls and store saves in flight (tests, shutdown). */
    async settled() {
      await Promise.all([...sending]);
    },
  };
}

export type StatusAlerter = ReturnType<typeof createStatusAlerter>;
