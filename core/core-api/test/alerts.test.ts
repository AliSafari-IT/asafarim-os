import { describe, expect, it, vi } from "vitest";
import { createStatusAlerter, parseAlertConfig, plain, splitMessages } from "../src/alerts.ts";
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
