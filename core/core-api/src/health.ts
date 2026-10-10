/**
 * App health and the platform status board (P6.1, ADR 0001 §9 "Health").
 *
 * Every `active` app's `runtime.health.live` and `.ready` (from its STORED manifest) are polled on a
 * fixed interval, at `<upstream origin><path>`, where the upstream is the one the generated gateway
 * uses for the app: `OS_APP_<ID>_UPSTREAM` (host:port). Nothing else is ever fetched: the URL is
 * built from those two parts only, redirects aren't followed, and a path that would leave the
 * upstream's origin (`//other.host/…` is a valid manifest path) is refused without a request.
 *
 * Installed and inactive apps are listed as "not polled"; removed apps aren't listed. A lifecycle
 * change calls `refresh()`, so the poll set follows at once. core-api itself is the pseudo-entry
 * `core-api` (live: it answers; ready: its own checks, the database and the bus).
 *
 * Results live in memory only: the latest per app, with `since` (when the current state began).
 * Each check has its own timeout and all of a round's checks run in parallel, so one slow or
 * hanging endpoint stalls nothing else; a round never starts while the previous one still runs.
 */
import type { GatewayState } from "./gateway.ts";

export type Probe = "up" | "down" | "unknown";

/**
 * Why a check isn't `up`. `timeout`: no answer within the per-request timeout; `refused`: nothing
 * listens there; `bad_status`: an answer that isn't 2xx (redirects included); `unreachable`: any
 * other network error; `no_upstream`: core-api doesn't know where the app runs; `bad_path`: the
 * manifest path would leave the upstream's origin; `check_failed`: one of core-api's own checks.
 */
export type HealthError =
  "timeout" | "refused" | "bad_status" | "unreachable" | "no_upstream" | "bad_path" | "check_failed";

export interface AppStatus {
  id: string;
  name: string;
  /** Lifecycle state; `core-api` for the pseudo-entry is always `active`. */
  state: string;
  /** False for an app that isn't active: its live/ready are `unknown`. */
  polled: boolean;
  live: Probe;
  ready: Probe;
  /** The slower of the two checks, in ms; null before the first check or when not polled. */
  latencyMs: number | null;
  error?: HealthError;
  /** The HTTP status behind `bad_status`, or a named core-api check behind `check_failed`. */
  detail?: string;
  /** When it was last checked; null when never (or not polled). */
  checkedAt: string | null;
  /** When the current state (polled, live, ready) began. */
  since: string;
}

export interface StatusReport {
  /** When the latest round finished; null before the first one. */
  checkedAt: string | null;
  intervalMs: number;
  apps: AppStatus[];
}

/** What the poller needs to know about an app: the apps table, minus removed ones. */
export interface HealthApp {
  id: string;
  state: GatewayState;
  manifest: { name?: string; runtime?: { health?: { live?: string; ready?: string } } };
}

export interface HealthDeps {
  /** The apps that aren't removed (core-api's own `core` catalog row is skipped). */
  apps: () => Promise<HealthApp[]>;
  /** Where an app runs (host:port or an http(s) origin), as the gateway knows it. */
  upstream: (appId: string) => string | undefined;
  /** core-api's own readiness checks, by name (database, bus); each resolves when healthy. */
  selfChecks?: Record<string, () => Promise<unknown>>;
  fetch?: typeof fetch;
  /** Between rounds; default 30 s. */
  intervalMs?: number;
  /** Per request; default 2 s. */
  timeoutMs?: number;
  now?: () => number;
  log?: (line: object) => void;
}

export const SELF_ID = "core-api";
const CATALOG_ID = "core";

/** The env var holding an app's upstream, as in the generated gateway (tools/platform-cli gatewayUpstreamVar). */
export const upstreamVar = (appId: string) => `OS_APP_${appId.toUpperCase().replace(/-/g, "_")}_UPSTREAM`;

/** CORE_API_HEALTH_INTERVAL_SECONDS (5–3600, default 30) and CORE_API_HEALTH_TIMEOUT_MS (100–10 000, default 2000). */
export function parseHealthConfig(env: Record<string, string | undefined>): { intervalMs: number; timeoutMs: number } {
  const num = (name: string, min: number, max: number, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(`${name} must be a whole number from ${min} to ${max}`);
    }
    return n;
  };
  return {
    intervalMs: num("CORE_API_HEALTH_INTERVAL_SECONDS", 5, 3600, 30) * 1000,
    timeoutMs: num("CORE_API_HEALTH_TIMEOUT_MS", 100, 10_000, 2000),
  };
}

/**
 * The one URL a health check may go to: the upstream's origin followed by the manifest path.
 * Undefined when the upstream isn't a plain host:port / http(s) origin, or the path would change the origin.
 */
export function healthUrl(upstream: string, path: string): string | undefined {
  let origin: string;
  try {
    const base = new URL(/^https?:\/\//i.test(upstream) ? upstream : `http://${upstream}`);
    if (base.username || base.password || (base.pathname !== "/" && base.pathname !== "")) return undefined;
    if (base.search || base.hash) return undefined;
    origin = base.origin;
  } catch {
    return undefined;
  }
  if (!path.startsWith("/")) return undefined;
  const url = `${origin}${path}`;
  try {
    return new URL(url).origin === origin ? url : undefined;
  } catch {
    return undefined;
  }
}

interface ProbeResult {
  probe: Probe;
  latencyMs: number;
  error?: HealthError;
  detail?: string;
}

/** Map a fetch failure to an error class. */
function classify(err: unknown, timedOut: boolean): HealthError {
  if (timedOut) return "timeout";
  const code = (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
  if (code === "ECONNREFUSED") return "refused";
  return "unreachable";
}

/** Run `work` with its own deadline; never waits past `ms`. */
async function withTimeout<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(Object.assign(new Error("timeout"), { timedOut: true }));
    }, ms);
  });
  try {
    return await Promise.race([work(ctl.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function createHealthPoller(deps: HealthDeps) {
  const fetchFn = deps.fetch ?? fetch;
  const intervalMs = deps.intervalMs ?? 30_000;
  const timeoutMs = deps.timeoutMs ?? 2000;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const iso = (ms: number) => new Date(ms).toISOString();

  /** The latest status per app id, kept in the order the apps were loaded. */
  let entries = new Map<string, AppStatus>();
  let lastRound: number | null = null;
  let inflight: Promise<void> | undefined;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;

  async function probe(url: string): Promise<ProbeResult> {
    const started = now();
    let timedOut = false;
    try {
      const res = await withTimeout(timeoutMs, (signal) =>
        fetchFn(url, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: { "user-agent": "asafarim-core-api-health" },
        }),
      ).catch((err: unknown) => {
        timedOut = Boolean((err as { timedOut?: boolean }).timedOut);
        throw err;
      });
      // Drop the body: only the status counts.
      await res.body?.cancel().catch(() => undefined);
      const latencyMs = now() - started;
      if (res.status >= 200 && res.status < 300) return { probe: "up", latencyMs };
      return { probe: "down", latencyMs, error: "bad_status", detail: String(res.status) };
    } catch (err) {
      return { probe: "down", latencyMs: now() - started, error: classify(err, timedOut) };
    }
  }

  async function selfProbe(): Promise<ProbeResult> {
    const started = now();
    const checks = Object.entries(deps.selfChecks ?? {});
    const failed: string[] = [];
    await Promise.all(
      checks.map(async ([name, check]) => {
        try {
          await withTimeout(timeoutMs, () => check());
        } catch {
          failed.push(name);
        }
      }),
    );
    const latencyMs = now() - started;
    if (failed.length === 0) return { probe: "up", latencyMs };
    return { probe: "down", latencyMs, error: "check_failed", detail: failed.sort().join(", ") };
  }

  /** Put a new result in place; `since` moves only when polled/live/ready changed. */
  function settle(next: Omit<AppStatus, "since">, at: number) {
    const prev = entries.get(next.id);
    const same = prev && prev.polled === next.polled && prev.live === next.live && prev.ready === next.ready;
    return { ...next, since: same ? prev.since : iso(at) };
  }

  async function round() {
    let apps: HealthApp[];
    try {
      apps = await deps.apps();
    } catch (err) {
      // Keep the last known results; the next round tries again.
      log({ msg: "health.apps_unavailable", error: (err as Error).message });
      return;
    }
    const results = await Promise.all(
      apps
        .filter((a) => a.id !== CATALOG_ID && a.state !== "removed")
        .map(async (app): Promise<Omit<AppStatus, "since">> => {
          const base = { id: app.id, name: app.manifest.name ?? app.id, state: app.state };
          if (app.state !== "active") {
            return { ...base, polled: false, live: "unknown", ready: "unknown", latencyMs: null, checkedAt: null };
          }
          const checkedAt = iso(now());
          const health = app.manifest.runtime?.health;
          const upstream = deps.upstream(app.id);
          if (!upstream) {
            return {
              ...base,
              polled: true,
              live: "unknown",
              ready: "unknown",
              latencyMs: null,
              error: "no_upstream",
              detail: upstreamVar(app.id),
              checkedAt,
            };
          }
          const liveUrl = health?.live ? healthUrl(upstream, health.live) : undefined;
          const readyUrl = health?.ready ? healthUrl(upstream, health.ready) : undefined;
          if (!liveUrl || !readyUrl) {
            return {
              ...base,
              polled: true,
              live: "unknown",
              ready: "unknown",
              latencyMs: null,
              error: "bad_path",
              checkedAt,
            };
          }
          const [live, ready] = await Promise.all([probe(liveUrl), probe(readyUrl)]);
          const failed = live.error ? live : ready;
          return {
            ...base,
            polled: true,
            live: live.probe,
            ready: ready.probe,
            latencyMs: Math.max(live.latencyMs, ready.latencyMs),
            ...(failed.error ? { error: failed.error } : {}),
            ...(failed.detail ? { detail: failed.detail } : {}),
            checkedAt,
          };
        }),
    );
    const self = await selfProbe();
    const selfEntry: Omit<AppStatus, "since"> = {
      id: SELF_ID,
      name: "core-api",
      state: "active",
      polled: true,
      live: "up", // it's answering this
      ready: self.probe,
      latencyMs: self.latencyMs,
      ...(self.error ? { error: self.error } : {}),
      ...(self.detail ? { detail: self.detail } : {}),
      checkedAt: iso(now()),
    };
    const done = now();
    const next = new Map<string, AppStatus>();
    // Removed apps (and ones no longer loaded) simply aren't carried over.
    for (const r of [selfEntry, ...results]) {
      const settled = settle(r, done);
      const prev = entries.get(r.id);
      if (prev && (prev.live !== settled.live || prev.ready !== settled.ready || prev.polled !== settled.polled)) {
        log({ msg: "health.changed", appId: r.id, live: settled.live, ready: settled.ready, error: settled.error });
      }
      next.set(r.id, settled);
    }
    entries = next;
    lastRound = done;
  }

  /** One round now; if one is already running, run once more after it (never two at once). */
  function poll(): Promise<void> {
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      try {
        do {
          again = false;
          await round();
        } while (again);
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      void poll().finally(schedule);
    }, intervalMs);
    timer.unref?.();
  }

  return {
    /** First round at once, then every `intervalMs` after the previous round finished. */
    start() {
      if (!stopped) return;
      stopped = false;
      void poll().finally(schedule);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    /** A lifecycle change: re-read the apps and check them now. */
    refresh: poll,
    /** Wait for the round in flight, if any (tests, shutdown). */
    async settled() {
      await inflight;
    },
    status(): StatusReport {
      return {
        checkedAt: lastRound === null ? null : iso(lastRound),
        intervalMs,
        apps: [...entries.values()],
      };
    },
  };
}

export type HealthPoller = ReturnType<typeof createHealthPoller>;
