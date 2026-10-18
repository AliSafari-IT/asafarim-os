import { describe, expect, it, vi } from "vitest";
import {
  createStatusAlerter,
  parseAlertConfig,
  parseDownRounds,
  plain,
  splitMessages,
  type AlertRecord,
  type AlertStore,
} from "../src/alerts.ts";
import type { AppStatus, StatusReport } from "../src/health.ts";

const HOOK = "https://discord.example/api/webhooks/123/secret-token";

function entry(id: string, over: Partial<AppStatus> = {}): AppStatus {
  return {
    id,
    name: id.toUpperCase(),
    state: "active",
    polled: true,
    live: "up",
    ready: "up",
    latencyMs: 3,
    checkedAt: "2026-10-17T10:00:00.000Z",
    since: "2026-10-17T10:00:00.000Z",
    ...over,
  };
}

/** The nth recorded call, failing the test when there is none. */
function nth<T>(list: T[], i: number): T {
  const item = list[i];
  if (item === undefined) throw new Error(`no call ${i}`);
  return item;
}

const report = (...apps: AppStatus[]): StatusReport => ({
  checkedAt: "2026-10-17T10:00:00.000Z",
  intervalMs: 30_000,
  apps,
});
const down = (id: string, over: Partial<AppStatus> = {}) =>
  entry(id, { ready: "down", error: "bad_status", detail: "503", ...over });

function setup(over: { downRounds?: number; status?: number; fetch?: typeof fetch } = {}) {
  const calls: { url: string; init: RequestInit; body: { content: string; allowed_mentions: unknown } }[] = [];
  const logs: object[] = [];
  const fetchFn =
    over.fetch ??
    (vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
      return new Response(null, { status: over.status ?? 204 });
    }) as unknown as typeof fetch);
  const alerter = createStatusAlerter({
    webhookUrl: HOOK,
    downRounds: over.downRounds ?? 2,
    fetch: fetchFn,
    log: (l) => logs.push(l),
  });
  return { alerter, calls, logs };
}

describe("status alerts", () => {
  it("splits a large round into several messages, in order, without losing an app", async () => {
    const { alerter, calls } = setup({ downRounds: 1 });
    const ids = Array.from({ length: 30 }, (_, i) => `app-${String(i).padStart(2, "0")}-${"x".repeat(40)}`);
    alerter.observe(report(...ids.map((id) => down(id, { name: `${id} name ${"y".repeat(40)}` }))));
    await alerter.settled();
    expect(calls.length).toBeGreaterThan(1);
    const contents = calls.map((c) => c.body.content);
    for (const c of contents) expect(c.length).toBeLessThanOrEqual(1900);
    expect(nth(contents, 0).startsWith("ASafariM OS status\n")).toBe(true);
    for (const c of contents.slice(1)) expect(c.startsWith("ASafariM OS status (continued)\n")).toBe(true);
    const lines = contents.flatMap((c) => c.split("\n").slice(1));
    expect(lines).toHaveLength(30);
    for (const [i, id] of ids.entries()) {
      expect(nth(lines, i)).toContain(`(${plain(id, 64)})`); // each app once, in round order
      expect(nth(lines, i).endsWith("…")).toBe(false);
    }
  });

  it("keeps sending the rest when one message of a round fails", async () => {
    const calls: string[] = [];
    const logs: object[] = [];
    let n = 0;
    const fetchFn = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
      calls.push(JSON.parse(String(init.body)).content);
      n += 1;
      if (n === 1) throw new TypeError("fetch failed");
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const alerter = createStatusAlerter({ webhookUrl: HOOK, downRounds: 1, fetch: fetchFn, log: (l) => logs.push(l) });
    alerter.observe(report(...Array.from({ length: 30 }, (_, i) => down(`app-${i}-${"z".repeat(60)}`))));
    await alerter.settled();
    expect(calls.length).toBeGreaterThan(1);
    expect(logs).toContainEqual({ msg: "health.alert_failed", error: "TypeError" });
    expect(logs.filter((l) => (l as { msg: string }).msg === "health.alert_sent")).toHaveLength(calls.length - 1);
  });

  it("says nothing while everything is up", async () => {
    const { alerter, calls } = setup();
    for (let i = 0; i < 5; i++) alerter.observe(report(entry("core-api"), entry("notes")));
    await alerter.settled();
    expect(calls).toHaveLength(0);
  });

  it("alerts once after downRounds unhealthy rounds in a row, then once when it recovers", async () => {
    const { alerter, calls } = setup({ downRounds: 2 });
    alerter.observe(report(entry("notes")));
    alerter.observe(report(down("notes")));
    await alerter.settled();
    expect(calls).toHaveLength(0); // one bad round is not an outage yet

    alerter.observe(report(down("notes")));
    alerter.observe(report(down("notes")));
    alerter.observe(report(down("notes")));
    await alerter.settled();
    expect(calls).toHaveLength(1);
    expect(nth(calls, 0).url).toBe(HOOK);
    expect(nth(calls, 0).init.method).toBe("POST");
    expect(nth(calls, 0).init.redirect).toBe("manual");
    expect(nth(calls, 0).body.content).toContain("Down: NOTES (notes): live up, ready down, bad\\_status 503");
    expect(nth(calls, 0).body.allowed_mentions).toEqual({ parse: [] });

    alerter.observe(report(entry("notes")));
    alerter.observe(report(entry("notes")));
    await alerter.settled();
    expect(calls).toHaveLength(2);
    expect(nth(calls, 1).body.content).toContain("Recovered: NOTES (notes): live up, ready up");
  });

  it("a flap shorter than downRounds sends nothing", async () => {
    const { alerter, calls } = setup({ downRounds: 3 });
    for (const bad of [true, true, false, true, true, false]) {
      alerter.observe(report(bad ? down("notes") : entry("notes")));
    }
    await alerter.settled();
    expect(calls).toHaveLength(0);
  });

  it("puts everything that changed in one round into one message", async () => {
    const { alerter, calls } = setup({ downRounds: 1 });
    alerter.observe(
      report(
        entry("core-api", { ready: "down", error: "check_failed", detail: "database" }),
        down("notes"),
        entry("docs", { live: "unknown", ready: "unknown", error: "no_upstream", detail: "OS_APP_DOCS_UPSTREAM" }),
      ),
    );
    await alerter.settled();
    expect(calls).toHaveLength(1);
    const lines = nth(calls, 0).body.content.split("\n");
    expect(lines).toEqual([
      "ASafariM OS status",
      "🔴 Down: CORE-API (core-api): live up, ready down, check\\_failed database",
      "🔴 Down: NOTES (notes): live up, ready down, bad\\_status 503",
      "🔴 Down: DOCS (docs): live unknown, ready unknown, no\\_upstream OS\\_APP\\_DOCS\\_UPSTREAM",
    ]);
  });

  it("a deactivated or removed app is not an outage, and is forgotten", async () => {
    const { alerter, calls } = setup({ downRounds: 1 });
    alerter.observe(report(down("notes")));
    await alerter.settled();
    expect(calls).toHaveLength(1);

    // Deactivated: not polled. No "recovered", no "down".
    alerter.observe(report(entry("notes", { state: "inactive", polled: false, live: "unknown", ready: "unknown" })));
    // Removed: gone from the board.
    alerter.observe(report());
    await alerter.settled();
    expect(calls).toHaveLength(1);

    // Active again and healthy: nothing to recover from, since its state was dropped.
    alerter.observe(report(entry("notes")));
    await alerter.settled();
    expect(calls).toHaveLength(1);
  });

  it("a round that couldn't read the app list counts only core-api, and forgets nobody", async () => {
    const { alerter, calls } = setup({ downRounds: 2 });
    alerter.observe(report(entry("core-api"), down("notes")));
    // Two rounds without an app list: notes' kept result isn't a second bad round; core-api's is new.
    const partial = { appsChecked: false };
    alerter.observe(
      report(entry("core-api", { ready: "down", error: "check_failed", detail: "database" }), down("notes")),
      partial,
    );
    alerter.observe(
      report(entry("core-api", { ready: "down", error: "check_failed", detail: "database" }), down("notes")),
      partial,
    );
    await alerter.settled();
    expect(calls).toHaveLength(1);
    expect(nth(calls, 0).body.content.split("\n")).toEqual([
      "ASafariM OS status",
      "🔴 Down: CORE-API (core-api): live up, ready down, check\\_failed database",
    ]);
    // The next full round is notes' second bad one.
    alerter.observe(report(entry("core-api"), down("notes")));
    await alerter.settled();
    expect(calls).toHaveLength(2);
    expect(nth(calls, 1).body.content).toContain("Down: NOTES");
    expect(nth(calls, 1).body.content).toContain("Recovered: CORE-API");
  });

  it("never puts upstreams or URLs in a message, and neutralises manifest text", async () => {
    const { alerter, calls } = setup({ downRounds: 1 });
    alerter.observe(report(down("evil", { name: "@everyone <https://x.example> `code` **bold**\nsecond line" })));
    await alerter.settled();
    const content = nth(calls, 0).body.content;
    expect(content).not.toMatch(/https?:/);
    expect(content).not.toContain("@");
    expect(content).not.toContain("`");
    expect(content).not.toContain("**");
    expect(content).toContain("\\*\\*bold\\*\\*"); // escaped, so it shows as typed
    expect(content.split("\n")).toHaveLength(2);
    expect(plain("a".repeat(200)).length).toBe(80);
  });

  it("a failing or hanging webhook is logged without the URL, and never throws", async () => {
    const failing = setup({ downRounds: 1, status: 429 });
    failing.alerter.observe(report(down("notes")));
    await failing.alerter.settled();
    expect(failing.logs).toEqual([{ msg: "health.alert_failed", status: 429 }]);

    const throwing = setup({
      downRounds: 1,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(() => throwing.alerter.observe(report(down("notes")))).not.toThrow();
    await throwing.alerter.settled();
    expect(throwing.logs).toEqual([{ msg: "health.alert_failed", error: "TypeError" }]);
    for (const l of [...failing.logs, ...throwing.logs]) expect(JSON.stringify(l)).not.toContain("secret-token");
  });

  it("gives up on a webhook that doesn't answer within the timeout", async () => {
    vi.useFakeTimers();
    try {
      const logs: object[] = [];
      const alerter = createStatusAlerter({
        webhookUrl: HOOK,
        downRounds: 1,
        timeoutMs: 1000,
        log: (l) => logs.push(l),
        fetch: ((_url: string, init: RequestInit) =>
          new Promise((_, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          })) as unknown as typeof fetch,
      });
      alerter.observe(report(down("notes")));
      await vi.advanceTimersByTimeAsync(1000);
      await alerter.settled();
      expect(logs).toEqual([{ msg: "health.alert_failed", error: "timeout" }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("alert history", () => {
  const clock = () => {
    let t = Date.parse("2026-10-17T10:00:00.000Z");
    return () => new Date((t += 30_000));
  };

  it("keeps every transition without a webhook, and sends nothing", async () => {
    const fetchFn = vi.fn();
    const alerter = createStatusAlerter({ downRounds: 2, now: clock(), fetch: fetchFn as unknown as typeof fetch });
    expect(alerter.history()).toEqual({ webhook: false, downRounds: 2, alerts: [] });
    alerter.observe(report(entry("core-api"), down("notes")));
    expect(alerter.history().alerts).toEqual([]); // one bad round is not down yet
    alerter.observe(report(entry("core-api"), down("notes")));
    alerter.observe(report(entry("core-api"), entry("notes")));
    await alerter.settled();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(alerter.history().alerts).toEqual([
      {
        at: "2026-10-17T10:01:00.000Z",
        kind: "recovered",
        id: "notes",
        name: "NOTES",
        live: "up",
        ready: "up",
      },
      {
        at: "2026-10-17T10:00:30.000Z",
        kind: "down",
        id: "notes",
        name: "NOTES",
        live: "up",
        ready: "down",
        error: "bad_status",
        detail: "503",
      },
    ]);
  });

  it("records the same transitions the webhook sends, and says the webhook is on without its URL", async () => {
    const { alerter, calls } = setup({ downRounds: 1 });
    alerter.observe(report(entry("core-api"), down("notes"), down("docs")));
    await alerter.settled();
    expect(calls).toHaveLength(1);
    const h = alerter.history();
    expect(h.webhook).toBe(true);
    expect(h.alerts.map((a) => [a.kind, a.id])).toEqual([
      ["down", "notes"],
      ["down", "docs"],
    ]);
    expect(JSON.stringify(h)).not.toContain("secret-token");
    expect(JSON.stringify(h)).not.toContain("discord");
  });

  it("keeps only the newest historySize transitions, newest first", () => {
    const alerter = createStatusAlerter({ downRounds: 1, historySize: 3, now: clock() });
    for (let i = 0; i < 4; i++) {
      alerter.observe(report(down("notes")));
      alerter.observe(report(entry("notes")));
    }
    const alerts = alerter.history().alerts;
    expect(alerts).toHaveLength(3);
    expect(alerts.map((a) => a.kind)).toEqual(["recovered", "down", "recovered"]);
    expect(alerts[0]!.at > alerts[1]!.at).toBe(true);
  });

  it("a fractional or negative historySize never makes observe throw", () => {
    for (const historySize of [1.5, -3]) {
      const alerter = createStatusAlerter({ downRounds: 1, historySize });
      expect(() => alerter.observe(report(down("notes")))).not.toThrow();
      expect(alerter.history().alerts.length).toBe(historySize > 0 ? 1 : 0);
    }
  });

  it("bounds an app's own text and strips control characters", () => {
    const alerter = createStatusAlerter({ downRounds: 1 });
    alerter.observe(report(down("notes", { name: `Bad\u0007${"n".repeat(200)}`, detail: "d".repeat(200) })));
    const [a] = alerter.history().alerts;
    expect(a!.name).not.toMatch(/\p{Cc}/u);
    expect(a!.name.length).toBeLessThanOrEqual(80);
    expect(a!.detail!.length).toBeLessThanOrEqual(64);
  });

  it("returns a copy: changing it doesn't change the history", () => {
    const alerter = createStatusAlerter({ downRounds: 1 });
    alerter.observe(report(down("notes")));
    alerter.history().alerts[0]!.id = "changed";
    alerter.history().alerts.pop();
    expect(alerter.history().alerts.map((a) => a.id)).toEqual(["notes"]);
  });

  it("forgets nothing when an app is deactivated: the history is a log, not the board", () => {
    const alerter = createStatusAlerter({ downRounds: 1 });
    alerter.observe(report(down("notes")));
    alerter.observe(report(entry("notes", { state: "inactive", polled: false, live: "unknown", ready: "unknown" })));
    expect(alerter.history().alerts.map((a) => [a.kind, a.id])).toEqual([["down", "notes"]]);
  });
});

describe("alert history store", () => {
  const clock = () => {
    let t = Date.parse("2026-10-17T10:00:00.000Z");
    return () => new Date((t += 30_000));
  };
  const rec = (at: string, kind: AlertRecord["kind"], id: string): AlertRecord => ({
    at,
    kind,
    id,
    name: id.toUpperCase(),
    live: "up",
    ready: kind === "down" ? "down" : "up",
  });

  function memoryStore(saved: AlertRecord[] = []) {
    const rounds: AlertRecord[][] = [];
    const store: AlertStore = {
      save: vi.fn(async (records: AlertRecord[]) => {
        rounds.push(records);
      }),
      recent: vi.fn(async (limit: number) => saved.slice(0, limit)),
    };
    return { store, rounds };
  }

  it("saves each round's transitions in history order, and nothing for a round without a change", async () => {
    const { store, rounds } = memoryStore();
    const alerter = createStatusAlerter({ downRounds: 1, now: clock(), store });
    alerter.observe(report(entry("core-api"), down("notes"), down("docs")));
    alerter.observe(report(entry("core-api"), down("notes"), down("docs"))); // still down: no change
    alerter.observe(report(entry("core-api"), entry("notes"), down("docs")));
    await alerter.settled();
    expect(rounds.map((r) => r.map((a) => [a.kind, a.id]))).toEqual([
      [
        ["down", "notes"],
        ["down", "docs"],
      ],
      [["recovered", "notes"]],
    ]);
    // The same records the history shows: newest round first, each round in its own order.
    expect(alerter.history().alerts).toEqual([...rounds[1]!, ...rounds[0]!]);
    // Its own copies: the history isn't changed through them.
    rounds[0]![0]!.id = "changed";
    expect(alerter.history().alerts.map((a) => a.id)).not.toContain("changed");
  });

  it("a failed save is logged by class, never its message, and changes nothing else", async () => {
    for (const save of [
      async () => {
        throw Object.assign(new Error("password=hunter2"), { code: "57P01" });
      },
      () => {
        throw new TypeError("sync"); // throws instead of rejecting
      },
    ]) {
      const logs: object[] = [];
      const calls: string[] = [];
      const fetchFn = vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch;
      const alerter = createStatusAlerter({
        webhookUrl: HOOK,
        downRounds: 1,
        fetch: fetchFn,
        log: (l) => logs.push(l),
        store: { save, recent: async () => [] },
      });
      expect(() => alerter.observe(report(down("notes")))).not.toThrow();
      await alerter.settled();
      expect(alerter.history().alerts.map((a) => a.id)).toEqual(["notes"]);
      expect(calls).toEqual([HOOK]); // the webhook still went out
      const failed = logs.filter((l) => (l as { msg: string }).msg === "health.alert_store_failed");
      expect(failed).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain("hunter2");
      expect(failed[0]).toEqual({
        msg: "health.alert_store_failed",
        error: expect.stringMatching(/^(57P01|TypeError)$/),
      });
    }
  });

  it("settled() waits for a slow save", async () => {
    let release = () => {};
    const done: string[] = [];
    const alerter = createStatusAlerter({
      downRounds: 1,
      store: {
        save: () =>
          new Promise<void>((r) => {
            release = () => {
              done.push("saved");
              r();
            };
          }),
        recent: async () => [],
      },
    });
    alerter.observe(report(down("notes")));
    const waiting = alerter.settled().then(() => done.push("settled"));
    await Promise.resolve();
    release();
    await waiting;
    expect(done).toEqual(["saved", "settled"]);
  });

  it("load() fills the history from the store, newest first, up to historySize", async () => {
    const saved = [
      rec("2026-10-17T09:02:00.000Z", "recovered", "notes"),
      rec("2026-10-17T09:01:00.000Z", "down", "notes"),
      rec("2026-10-17T09:01:00.000Z", "down", "docs"),
    ];
    const { store } = memoryStore(saved);
    const alerter = createStatusAlerter({ downRounds: 1, historySize: 2, store });
    await alerter.load();
    expect(store.recent).toHaveBeenCalledWith(2);
    expect(alerter.history().alerts).toEqual(saved.slice(0, 2));
    // A copy: changing what the store returned doesn't change the history.
    saved[0]!.id = "changed";
    expect(alerter.history().alerts[0]!.id).toBe("notes");
  });

  it("load() keeps what this process already saw on top, and leaves out rows that aren't older", async () => {
    const now = clock(); // first round at 10:00:30
    const saved = [
      rec("2026-10-17T10:00:30.000Z", "down", "notes"), // this process's own round, already saved
      rec("2026-10-17T09:00:00.000Z", "recovered", "docs"),
    ];
    const { store } = memoryStore(saved);
    const alerter = createStatusAlerter({ downRounds: 1, now, store });
    alerter.observe(report(down("notes")));
    await alerter.load();
    expect(alerter.history().alerts.map((a) => [a.at, a.kind, a.id])).toEqual([
      ["2026-10-17T10:00:30.000Z", "down", "notes"],
      ["2026-10-17T09:00:00.000Z", "recovered", "docs"],
    ]);
  });

  it("a failed load is logged by class and leaves the history as it was; no store or size 0 = no call", async () => {
    const logs: object[] = [];
    const alerter = createStatusAlerter({
      downRounds: 1,
      log: (l) => logs.push(l),
      store: {
        save: async () => {},
        recent: async () => {
          throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" });
        },
      },
    });
    await expect(alerter.load()).resolves.toBeUndefined();
    expect(alerter.history().alerts).toEqual([]);
    expect(logs).toEqual([{ msg: "health.alert_history_load_failed", error: "ECONNREFUSED" }]);

    await expect(createStatusAlerter({ downRounds: 1 }).load()).resolves.toBeUndefined();
    const { store } = memoryStore();
    await createStatusAlerter({ downRounds: 1, historySize: 0, store }).load();
    expect(store.recent).not.toHaveBeenCalled();
  });
});

describe("alerted state across a restart", () => {
  /** Saved "down" rows for these apps, a minute ago. */
  const openNow = (...ids: string[]) => {
    const at = new Date(Date.now() - 60_000).toISOString();
    return async () => ids.map((id) => ({ id, at }));
  };
  function restarted(open: AlertStore["open"], over: { historySize?: number } = {}) {
    const calls: string[] = [];
    const logs: object[] = [];
    const fetchFn = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
      calls.push(JSON.parse(String(init.body)).content);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const store: AlertStore = { save: vi.fn(async () => {}), recent: async () => [], ...(open ? { open } : {}) };
    const alerter = createStatusAlerter({
      webhookUrl: HOOK,
      downRounds: 2,
      fetch: fetchFn,
      log: (l) => logs.push(l),
      store,
      ...over,
    });
    return { alerter, calls, logs, store };
  }

  it("an app still down after a restart gets no second down, and its recovery still goes out", async () => {
    const { alerter, calls, logs, store } = restarted(openNow("notes"));
    await alerter.load();
    expect(logs).toContainEqual({ msg: "health.alert_state_loaded", count: 1 });
    alerter.observe(report(entry("core-api"), down("notes")));
    alerter.observe(report(entry("core-api"), down("notes")));
    alerter.observe(report(entry("core-api"), down("notes")));
    await alerter.settled();
    expect(calls).toEqual([]);
    expect(alerter.history().alerts).toEqual([]);
    expect(store.save).not.toHaveBeenCalled();

    alerter.observe(report(entry("core-api"), entry("notes")));
    await alerter.settled();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.split("\n").slice(1)).toEqual(["🟢 Recovered: NOTES (notes): live up, ready up"]);
    expect(alerter.history().alerts.map((a) => [a.kind, a.id])).toEqual([["recovered", "notes"]]);
  });

  it("an app that was alerted and is healthy on the first round after the restart recovers at once", async () => {
    const { alerter, calls } = restarted(openNow("docs"));
    await alerter.load();
    alerter.observe(report(entry("core-api"), entry("docs")));
    await alerter.settled();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("🟢 Recovered: DOCS (docs)");
  });

  it("an app that wasn't alerted before the restart is counted from zero, as before", async () => {
    const { alerter, calls } = restarted(openNow());
    await alerter.load();
    alerter.observe(report(down("notes")));
    await alerter.settled();
    expect(calls).toEqual([]); // one bad round of two
    alerter.observe(report(down("notes")));
    await alerter.settled();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("🔴 Down: NOTES (notes)");
  });

  it("a restored app that is gone (deactivated or removed) is forgotten quietly", async () => {
    const { alerter, calls } = restarted(openNow("gone"));
    await alerter.load();
    alerter.observe(report(entry("core-api")));
    alerter.observe(report(entry("core-api"), entry("gone"))); // active again later: a fresh start
    await alerter.settled();
    expect(calls).toEqual([]);
  });

  it("what this process already saw wins over the store", async () => {
    const { alerter, calls } = restarted(openNow("notes"));
    alerter.observe(report(entry("notes"))); // seen healthy before load()
    await alerter.load();
    alerter.observe(report(entry("notes")));
    await alerter.settled();
    expect(calls).toEqual([]); // no "recovered" for an app this process saw healthy
  });

  it("an older down is not restored: an outage past restoreMaxAgeMs is announced again", async () => {
    const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    const { alerter, calls, logs } = restarted(async () => [
      { id: "stale", at: at(25 * 60 * 60 * 1000) }, // past the 24 h default
      { id: "fresh", at: at(23 * 60 * 60 * 1000) },
      { id: "garbled", at: "not a time" },
    ]);
    await alerter.load();
    expect(logs).toContainEqual({ msg: "health.alert_state_loaded", count: 1 });
    for (let i = 0; i < 2; i++) alerter.observe(report(down("stale"), down("fresh"), down("garbled")));
    await alerter.settled();
    expect(calls).toHaveLength(1);
    const lines = calls[0]!.split("\n").slice(1);
    expect(lines.map((l) => l.split(":")[1]!.trim())).toEqual(["STALE (stale)", "GARBLED (garbled)"]);

    const short = createStatusAlerter({
      downRounds: 1,
      restoreMaxAgeMs: 30_000,
      store: { save: async () => {}, recent: async () => [], open: openNow("notes") }, // a minute ago
    });
    await short.load();
    short.observe(report(down("notes")));
    expect(short.history().alerts.map((a) => [a.kind, a.id])).toEqual([["down", "notes"]]);
  });

  it("restores the state even with historySize 0, and without open() nothing is restored", async () => {
    const zero = restarted(openNow("notes"), { historySize: 0 });
    await zero.alerter.load();
    zero.alerter.observe(report(down("notes")));
    zero.alerter.observe(report(down("notes")));
    await zero.alerter.settled();
    expect(zero.calls).toEqual([]);

    const none = restarted(undefined);
    await none.alerter.load();
    expect(none.logs).not.toContainEqual(expect.objectContaining({ msg: "health.alert_state_loaded" }));
    none.alerter.observe(report(down("notes")));
    none.alerter.observe(report(down("notes")));
    await none.alerter.settled();
    expect(none.calls).toHaveLength(1);
  });

  it("a failed state load is logged by class only, keeps the history load, and alerts as before", async () => {
    const { alerter, calls, logs } = restarted(async () => {
      throw Object.assign(new Error("password=hunter2"), { code: "57P01" });
    });
    await expect(alerter.load()).resolves.toBeUndefined();
    expect(logs).toContainEqual({ msg: "health.alert_state_load_failed", error: "57P01" });
    expect(logs).toContainEqual({ msg: "health.alert_history_loaded", count: 0 });
    expect(JSON.stringify(logs)).not.toContain("hunter2");
    alerter.observe(report(down("notes")));
    alerter.observe(report(down("notes")));
    await alerter.settled();
    expect(calls).toHaveLength(1);
  });
});

describe("parseDownRounds", () => {
  it("defaults to 2 and takes 1 to 20 without a webhook", () => {
    expect(parseDownRounds({})).toBe(2);
    expect(parseDownRounds({ CORE_API_ALERT_DOWN_ROUNDS: "" })).toBe(2);
    expect(parseDownRounds({ CORE_API_ALERT_DOWN_ROUNDS: "4" })).toBe(4);
    expect(() => parseDownRounds({ CORE_API_ALERT_DOWN_ROUNDS: "0" })).toThrow(/1 to 20/);
  });
});

describe("parseAlertConfig", () => {
  it("is off when the webhook isn't set", () => {
    expect(parseAlertConfig({})).toBeUndefined();
    expect(parseAlertConfig({ CORE_API_ALERT_WEBHOOK_URL: "" })).toBeUndefined();
  });

  it("takes an https URL, with 2 rounds by default", () => {
    expect(parseAlertConfig({ CORE_API_ALERT_WEBHOOK_URL: HOOK })).toEqual({ webhookUrl: HOOK, downRounds: 2 });
    expect(parseAlertConfig({ CORE_API_ALERT_WEBHOOK_URL: HOOK, CORE_API_ALERT_DOWN_ROUNDS: "5" })).toMatchObject({
      downRounds: 5,
    });
  });

  it("refuses anything but https without credentials, and never echoes the value", () => {
    for (const bad of ["http://discord.example/hook", "not a url", "https://user:pw@discord.example/hook"]) {
      let message = "";
      try {
        parseAlertConfig({ CORE_API_ALERT_WEBHOOK_URL: bad });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, bad).toBe("CORE_API_ALERT_WEBHOOK_URL must be an https URL");
    }
    for (const bad of ["0", "21", "1.5", "two"]) {
      expect(
        () => parseAlertConfig({ CORE_API_ALERT_WEBHOOK_URL: HOOK, CORE_API_ALERT_DOWN_ROUNDS: bad }),
        bad,
      ).toThrow(/1 to 20/);
    }
  });
});

describe("splitMessages", () => {
  it("keeps a round that fits in one message", () => {
    expect(splitMessages(["a", "b"])).toEqual(["ASafariM OS status\na\nb"]);
    expect(splitMessages([])).toEqual([]);
  });

  it("never cuts a line between messages and keeps each message within the cap", () => {
    const lines = Array.from({ length: 9 }, (_, i) => `${i}`.repeat(30));
    const out = splitMessages(lines, 100);
    for (const m of out) expect(m.length).toBeLessThanOrEqual(100);
    expect(out.flatMap((m) => m.split("\n").slice(1))).toEqual(lines);
  });

  it("shortens only a single line that is longer than a whole message", () => {
    const out = splitMessages(["ok", "L".repeat(500), "after"], 100);
    for (const m of out) expect(m.length).toBeLessThanOrEqual(100);
    const lines = out.flatMap((m) => m.split("\n").slice(1));
    expect(lines).toHaveLength(3);
    expect(nth(lines, 0)).toBe("ok");
    expect(nth(lines, 1).endsWith("…")).toBe(true);
    expect(nth(lines, 2)).toBe("after");
  });
});

describe("an alerted app that stops being polled is cleared in the store", () => {
  function clearing(over: { clear?: AlertStore["clear"] } = {}) {
    const calls: string[] = [];
    const logs: object[] = [];
    const cleared: { ids: string[]; at: string }[] = [];
    const fetchFn = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
      calls.push(JSON.parse(String(init.body)).content);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const store: AlertStore = {
      save: vi.fn(async () => {}),
      recent: async () => [],
      clear:
        over.clear ??
        vi.fn(async (ids: string[], at: string) => {
          cleared.push({ ids: [...ids], at });
        }),
    };
    let t = Date.parse("2026-10-18T03:00:00.000Z");
    const alerter = createStatusAlerter({
      webhookUrl: HOOK,
      downRounds: 1,
      fetch: fetchFn,
      log: (l) => logs.push(l),
      now: () => new Date((t += 1_000)),
      store,
    });
    return { alerter, calls, logs, cleared, store };
  }

  it("deactivated or removed while down: one clear, and nothing in the history or the webhook", async () => {
    const { alerter, calls, cleared } = clearing();
    alerter.observe(report(entry("core-api"), down("notes"), down("docs")));
    await alerter.settled();
    expect(calls).toHaveLength(1);
    // notes deactivated (no longer polled), docs removed (gone from the report)
    alerter.observe(report(entry("core-api"), entry("notes", { state: "inactive", polled: false })));
    await alerter.settled();
    expect(cleared).toEqual([{ ids: ["notes", "docs"], at: "2026-10-18T03:00:02.000Z" }]);
    expect(calls).toHaveLength(1);
    expect(alerter.history().alerts.map((a) => [a.kind, a.id])).toEqual([
      ["down", "notes"],
      ["down", "docs"],
    ]);
    alerter.observe(report(entry("core-api")));
    await alerter.settled();
    expect(cleared).toHaveLength(1); // once, not every round
  });

  it("an app that was never alerted on, or has recovered, is not cleared", async () => {
    const { alerter, cleared, store } = clearing();
    alerter.observe(report(entry("core-api"), entry("notes"), down("docs")));
    alerter.observe(report(entry("core-api"), entry("notes"), entry("docs")));
    alerter.observe(report(entry("core-api")));
    await alerter.settled();
    expect(cleared).toEqual([]);
    expect(store.clear).not.toHaveBeenCalled();
  });

  it("a restored alerted app that is gone after the restart is cleared too", async () => {
    const { alerter, cleared, store } = clearing();
    store.open = async () => [{ id: "gone", at: new Date(Date.now() - 60_000).toISOString() }];
    await alerter.load();
    alerter.observe(report(entry("core-api")));
    await alerter.settled();
    expect(cleared.map((c) => c.ids)).toEqual([["gone"]]);
  });

  it("a round that couldn't read the app list clears nothing", async () => {
    const { alerter, cleared } = clearing();
    alerter.observe(report(entry("core-api"), down("notes")));
    alerter.observe(report(entry("core-api"), down("notes")), { appsChecked: false }); // notes: kept result
    await alerter.settled();
    expect(cleared).toEqual([]);
  });

  it("a failed clear is logged by class only and never breaks the round", async () => {
    const { alerter, calls, logs } = clearing({
      clear: () => {
        throw Object.assign(new Error("password=hunter2"), { code: "57P01" });
      },
    });
    alerter.observe(report(entry("core-api"), down("notes")));
    expect(() => alerter.observe(report(entry("core-api"), down("docs")))).not.toThrow();
    await alerter.settled();
    expect(logs).toContainEqual({ msg: "health.alert_clear_failed", error: "57P01" });
    expect(JSON.stringify(logs)).not.toContain("hunter2");
    expect(calls).toHaveLength(2); // the second round's "down" still went out
  });

  it("a store without clear() is fine: the app is forgotten as before", async () => {
    const alerter = createStatusAlerter({ downRounds: 1, store: { save: async () => {}, recent: async () => [] } });
    alerter.observe(report(down("notes")));
    expect(() => alerter.observe(report())).not.toThrow();
    await alerter.settled();
  });
});
