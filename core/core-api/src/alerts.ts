/**
 * Status alerts (P6.1 follow-up, ADR 0001 §9 "alerts go to the existing Discord deploy channel").
 *
 * The health poller hands every finished round to `observe()`. An entry that is polled and not both
 * live and ready for `downRounds` rounds in a row is **down**: one message says so. When it is live
 * and ready again, one message says it recovered. Nothing else is sent: an app that is deactivated or
 * removed is not an outage (its state is dropped quietly), and a state that holds sends nothing more.
 * Everything that changed in one round goes out in one webhook call.
 *
 * Off unless `CORE_API_ALERT_WEBHOOK_URL` is set. The URL is a secret (whoever holds it can post),
 * so it is never logged or returned. A message carries only the app id and name, live/ready, the
 * error class and its detail (an HTTP status, a core-api check name or an env var name); never an
 * upstream, a URL or a header. Mentions are disabled. A failed or slow send is logged by status or
 * class and dropped: it never delays a poll round, and nothing is retried.
 */
import type { AppStatus, StatusReport } from "./health.ts";

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
  const rounds = env.CORE_API_ALERT_DOWN_ROUNDS;
  let downRounds = 2;
  if (rounds !== undefined && rounds !== "") {
    downRounds = Number(rounds);
    if (!Number.isInteger(downRounds) || downRounds < 1 || downRounds > 20) {
      throw new Error("CORE_API_ALERT_DOWN_ROUNDS must be a whole number from 1 to 20");
    }
  }
  return { webhookUrl: url.href, downRounds };
}

export interface AlerterDeps extends AlertConfig {
  fetch?: typeof fetch;
  /** Per webhook call; default 5 s. */
  timeoutMs?: number;
  log?: (line: object) => void;
}

interface Tracked {
  /** Unhealthy rounds in a row; 0 while healthy. */
  bad: number;
  /** A "down" message went out and no "recovered" yet. */
  alerted: boolean;
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

export function createStatusAlerter(deps: AlerterDeps) {
  const fetchFn = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 5000;
  const log = deps.log ?? (() => undefined);
  const tracked = new Map<string, Tracked>();
  const sending = new Set<Promise<void>>();

  async function send(content: string) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchFn(deps.webhookUrl, {
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

  return {
    /** One finished poll round. Never throws, never waits for the webhook. */
    observe(report: StatusReport) {
      const down: AppStatus[] = [];
      const recovered: AppStatus[] = [];
      const seen = new Set<string>();
      for (const a of report.apps) {
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
      const lines = [
        ...down.map((a) => `🔴 Down: ${describe(a)}`),
        ...recovered.map((a) => `🟢 Recovered: ${describe(a)}`),
      ];
      let content = `ASafariM OS status\n${lines.join("\n")}`;
      if (content.length > MAX_CONTENT) content = `${content.slice(0, MAX_CONTENT - 1)}…`;
      const p = send(content).finally(() => sending.delete(p));
      sending.add(p);
    },
    /** Wait for the webhook calls in flight (tests, shutdown). */
    async settled() {
      await Promise.all([...sending]);
    },
  };
}

export type StatusAlerter = ReturnType<typeof createStatusAlerter>;
