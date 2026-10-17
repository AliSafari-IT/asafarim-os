import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHealthPoller, healthUrl, parseHealthConfig, type HealthApp } from "../src/health.ts";

const T0 = Date.parse("2026-10-10T12:00:00.000Z");

function app(id: string, state: HealthApp["state"] = "active", health = { live: "/healthz", ready: "/readyz" }) {
  return { id, state, manifest: { name: id.toUpperCase(), runtime: { health } } } satisfies HealthApp;
}

type Handler = (url: string, init: RequestInit) => Promise<Response>;

/** A fetch stub: answers per URL, records every call, and honours the abort signal like real fetch. */
function stubFetch(handlers: Record<string, Handler | number>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const h = handlers[url];
    if (h === undefined) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    if (typeof h === "number") return new Response(null, { status: h });
    return h(url, init);
  });
  return { fetch: fn as unknown as typeof fetch, calls, handlers };
}

const hang: Handler = (_url, init) =>
  new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

const refused: Handler = async () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
};

const UPSTREAMS: Record<string, string> = { notes: "localhost:4100", docs: "localhost:4200" };

describe("the health poller (P6.1)", () => {
  let apps: HealthApp[];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    apps = [app("notes")];
  });
  afterEach(() => vi.useRealTimers());

  function poller(fetchFn: typeof fetch, over: Partial<Parameters<typeof createHealthPoller>[0]> = {}) {
    return createHealthPoller({
      apps: async () => apps,
      upstream: (id) => UPSTREAMS[id],
      fetch: fetchFn,
      ...over,
    });
  }
  const entry = (p: ReturnType<typeof poller>, id: string) => p.status().apps.find((a) => a.id === id);

  it("an app whose live and ready answer 2xx is up, with its latency and when it was checked", async () => {
    const f = stubFetch({ "http://localhost:4100/healthz": 200, "http://localhost:4100/readyz": 204 });
    const p = poller(f.fetch);
    await p.refresh();
    expect(entry(p, "notes")).toMatchObject({
      id: "notes",
      name: "NOTES",
      state: "active",
      polled: true,
      live: "up",
      ready: "up",
      latencyMs: 0,
      checkedAt: new Date(T0).toISOString(),
      since: new Date(T0).toISOString(),
    });
    expect(entry(p, "notes")!.error).toBeUndefined();
    expect(p.status().checkedAt).toBe(new Date(T0).toISOString());
  });

  it("a non-2xx answer is down with bad_status and the status; a redirect isn't followed", async () => {
    const f = stubFetch({ "http://localhost:4100/healthz": 200, "http://localhost:4100/readyz": 503 });
    const p = poller(f.fetch);
    await p.refresh();
    expect(entry(p, "notes")).toMatchObject({ live: "up", ready: "down", error: "bad_status", detail: "503" });

    f.handlers["http://localhost:4100/healthz"] = 302;
    await p.refresh();
    expect(entry(p, "notes")).toMatchObject({ live: "down", error: "bad_status", detail: "302" });
    for (const c of f.calls) expect(c.init.redirect).toBe("manual");
  });

  it("nothing listening is refused; any other network error is unreachable", async () => {
    const f = stubFetch({ "http://localhost:4100/healthz": refused, "http://localhost:4100/readyz": refused });
    const p = poller(f.fetch);
    await p.refresh();
    expect(entry(p, "notes")).toMatchObject({ live: "down", ready: "down", error: "refused" });

    delete f.handlers["http://localhost:4100/healthz"];
    delete f.handlers["http://localhost:4100/readyz"];
    await p.refresh();
    expect(entry(p, "notes")).toMatchObject({ live: "down", error: "unreachable" });
  });

  it("a hanging endpoint times out after the per-request timeout and doesn't hold up another app", async () => {
    apps = [app("notes"), app("docs")];
    const f = stubFetch({
      "http://localhost:4100/healthz": hang,
      "http://localhost:4100/readyz": hang,
      "http://localhost:4200/healthz": 200,
      "http://localhost:4200/readyz": 200,
    });
    const p = poller(f.fetch, { timeoutMs: 2000 });
    let done = false;
    const round = p.refresh().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await round;
    expect(entry(p, "notes")).toMatchObject({ live: "down", ready: "down", error: "timeout", latencyMs: 2000 });
    expect(entry(p, "docs")).toMatchObject({ live: "up", ready: "up" });
    // Every request carried an abort signal, and the hanging ones were aborted.
    expect(f.calls.filter((c) => c.url.startsWith("http://localhost:4100")).every((c) => c.init.signal?.aborted)).toBe(
      true,
    );
  });

  it("`since` stays while the state holds and moves when it changes", async () => {
    const f = stubFetch({ "http://localhost:4100/healthz": 200, "http://localhost:4100/readyz": 200 });
    const p = poller(f.fetch);
    await p.refresh();
    vi.setSystemTime(T0 + 30_000);
    await p.refresh();
    expect(entry(p, "notes")).toMatchObject({
      live: "up",
      since: new Date(T0).toISOString(),
      checkedAt: new Date(T0 + 30_000).toISOString(),
    });

    vi.setSystemTime(T0 + 60_000);
    f.handlers["http://localhost:4100/readyz"] = refused;
    await p.refresh();
    expect(entry(p, "notes")).toMatchObject({ ready: "down", since: new Date(T0 + 60_000).toISOString() });

    vi.setSystemTime(T0 + 90_000);
    f.handlers["http://localhost:4100/readyz"] = 200;
    await p.refresh();
    expect(entry(p, "notes")).toMatchObject({ ready: "up", since: new Date(T0 + 90_000).toISOString() });
  });

  it("follows the lifecycle: an inactive app isn't polled, a removed one disappears", async () => {
    const f = stubFetch({ "http://localhost:4100/healthz": 200, "http://localhost:4100/readyz": 200 });
    const p = poller(f.fetch);
    await p.refresh();
    expect(f.calls).toHaveLength(2);

    apps = [app("notes", "inactive")];
    vi.setSystemTime(T0 + 5000);
    await p.refresh();
    expect(f.calls).toHaveLength(2); // nothing more fetched
    expect(entry(p, "notes")).toMatchObject({
      state: "inactive",
      polled: false,
      live: "unknown",
      ready: "unknown",
      latencyMs: null,
      checkedAt: null,
      since: new Date(T0 + 5000).toISOString(),
    });

    apps = [app("notes", "installed")];
    await p.refresh();
    expect(entry(p, "notes")).toMatchObject({ state: "installed", polled: false });

    apps = [{ ...app("notes"), state: "removed" }];
    await p.refresh();
    expect(entry(p, "notes")).toBeUndefined();
    apps = [];
    await p.refresh();
    expect(p.status().apps.map((a) => a.id)).toEqual(["core-api"]);
  });

  it("never runs two rounds at once: a refresh during a round runs once more after it", async () => {
    const f = stubFetch({ "http://localhost:4100/healthz": hang, "http://localhost:4100/readyz": hang });
    const p = poller(f.fetch, { timeoutMs: 2000 });
    const first = p.refresh();
    expect(f.calls).toHaveLength(0); // the apps load first
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(2);
    void p.refresh();
    void p.refresh();
    await vi.advanceTimersByTimeAsync(10);
    expect(f.calls).toHaveLength(2); // no overlapping round
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.calls).toHaveLength(4); // exactly one more round, after the first
    await vi.advanceTimersByTimeAsync(2000);
    await first;
    expect(f.calls).toHaveLength(4);
  });

  it("polls on its interval once started, and stops", async () => {
    const f = stubFetch({ "http://localhost:4100/healthz": 200, "http://localhost:4100/readyz": 200 });
    const p = poller(f.fetch, { intervalMs: 30_000 });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(4);
    p.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.calls).toHaveLength(4);
  });

  it("only ever fetches <upstream origin><manifest path>", async () => {
    apps = [
      app("notes"),
      app("docs", "active", { live: "//evil.example/x", ready: "@evil.example/x" }),
      app("nowhere"), // no upstream
      { id: "core", state: "active", manifest: { name: "Core" } }, // core-api's own catalog row
    ];
    const f = stubFetch({ "http://localhost:4100/healthz": 200, "http://localhost:4100/readyz": 200 });
    const p = poller(f.fetch);
    await p.refresh();
    // A `//host` path stays on the upstream; a path that doesn't start with / is never fetched.
    expect(f.calls.map((c) => c.url).sort()).toEqual(["http://localhost:4100/healthz", "http://localhost:4100/readyz"]);
    expect(entry(p, "docs")).toMatchObject({ live: "unknown", ready: "unknown", error: "bad_path" });
    expect(entry(p, "nowhere")).toMatchObject({
      polled: true,
      live: "unknown",
      error: "no_upstream",
      detail: "OS_APP_NOWHERE_UPSTREAM",
    });
    expect(entry(p, "core")).toBeUndefined();
  });

  it("core-api is listed first, ready when its own checks pass and naming the ones that fail", async () => {
    let dbUp = true;
    const f = stubFetch({ "http://localhost:4100/healthz": 200, "http://localhost:4100/readyz": 200 });
    const p = poller(f.fetch, {
      selfChecks: {
        database: async () => {
          if (!dbUp) throw new Error("down");
        },
        bus: async () => undefined,
      },
    });
    await p.refresh();
    expect(p.status().apps[0]).toMatchObject({ id: "core-api", state: "active", live: "up", ready: "up" });

    dbUp = false;
    await p.refresh();
    expect(p.status().apps[0]).toMatchObject({ ready: "down", error: "check_failed", detail: "database" });
  });

  it("a failed app list keeps the last results", async () => {
    const f = stubFetch({ "http://localhost:4100/healthz": 200, "http://localhost:4100/readyz": 200 });
    let fail = false;
    const p = poller(f.fetch, {
      apps: async () => {
        if (fail) throw new Error("db down");
        return apps;
      },
    });
    await p.refresh();
    fail = true;
    await p.refresh();
    expect(entry(p, "notes")).toMatchObject({ live: "up" });
  });

  it("a failed app list still checks core-api itself, so a database outage shows (and reaches onRound)", async () => {
    const f = stubFetch({ "http://localhost:4100/healthz": 200, "http://localhost:4100/readyz": 200 });
    let dbUp = true;
    const rounds: string[][] = [];
    const p = poller(f.fetch, {
      apps: async () => {
        if (!dbUp) throw new Error("db down");
        return apps;
      },
      selfChecks: {
        database: async () => {
          if (!dbUp) throw new Error("down");
        },
      },
      onRound: (r) => rounds.push(r.apps.map((a) => `${a.id}:${a.ready}`)),
    });
    await p.refresh();
    dbUp = false;
    await p.refresh();
    expect(p.status().apps[0]).toMatchObject({
      id: "core-api",
      ready: "down",
      error: "check_failed",
      detail: "database",
    });
    expect(entry(p, "notes")).toMatchObject({ live: "up", ready: "up" });
    expect(rounds).toEqual([
      ["core-api:up", "notes:up"],
      ["core-api:down", "notes:up"],
    ]);
  });

  it("a throwing onRound is logged and polling carries on", async () => {
    const f = stubFetch({ "http://localhost:4100/healthz": 200, "http://localhost:4100/readyz": 200 });
    const logs: object[] = [];
    const p = poller(f.fetch, {
      onRound: () => {
        throw new Error("boom");
      },
      log: (l) => logs.push(l),
    });
    await p.refresh();
    await p.refresh();
    expect(logs).toEqual([
      { msg: "health.on_round_failed", error: "boom" },
      { msg: "health.on_round_failed", error: "boom" },
    ]);
    expect(entry(p, "notes")).toMatchObject({ live: "up" });
  });
});

describe("healthUrl", () => {
  it("joins the upstream's origin and the path", () => {
    expect(healthUrl("localhost:4100", "/healthz")).toBe("http://localhost:4100/healthz");
    expect(healthUrl("notes:3000", "/api/ready")).toBe("http://notes:3000/api/ready");
    expect(healthUrl("http://notes:3000", "/h")).toBe("http://notes:3000/h");
    expect(healthUrl("https://notes.internal", "/h")).toBe("https://notes.internal/h");
  });

  it("keeps a //host path on the upstream, and refuses a relative path or an upstream that isn't a plain origin", () => {
    expect(healthUrl("localhost:4100", "//evil.example/x")).toBe("http://localhost:4100//evil.example/x");
    expect(healthUrl("localhost:4100", "h")).toBeUndefined();
    expect(healthUrl("user:pw@localhost:4100", "/h")).toBeUndefined();
    expect(healthUrl("localhost:4100/base", "/h")).toBeUndefined();
    expect(healthUrl("ftp://localhost", "/h")).toBeUndefined();
  });
});

describe("parseHealthConfig", () => {
  it("defaults to 30 s and 2 s, and checks the bounds", () => {
    expect(parseHealthConfig({})).toEqual({ intervalMs: 30_000, timeoutMs: 2000 });
    expect(parseHealthConfig({ CORE_API_HEALTH_INTERVAL_SECONDS: "5", CORE_API_HEALTH_TIMEOUT_MS: "500" })).toEqual({
      intervalMs: 5000,
      timeoutMs: 500,
    });
    for (const bad of ["4", "3601", "1.5", "x"]) {
      expect(() => parseHealthConfig({ CORE_API_HEALTH_INTERVAL_SECONDS: bad }), bad).toThrow(/5 to 3600/);
    }
    expect(() => parseHealthConfig({ CORE_API_HEALTH_TIMEOUT_MS: "50" })).toThrow(/100 to 10000/);
  });
});
