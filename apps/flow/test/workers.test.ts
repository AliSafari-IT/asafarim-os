/**
 * Production has no event bus yet (no ASAFARIM_NATS_URL): Flow must still start. Its subscribers and its relay stay
 * off, each with one clear log line, and nothing tries to reach a bus or the database at start.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAppRelay } from "@asafarim/app-sdk/events";
import type { Engine } from "../lib/engine/engine";
import { startWorkers } from "../lib/engine/workers";
import { log } from "../lib/log";

afterEach(() => vi.restoreAllMocks());

describe("without a bus", () => {
  it("starts the workers with no subscriber, logs flow.subscribers.no_bus once, and stops cleanly", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const pool = vi.fn(() => Promise.reject(new Error("no database in this test")));
    const workers = startWorkers({ pool, engine: {} as Engine, wake: vi.fn(), env: {} });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("flow.subscribers.no_bus", expect.objectContaining({ hint: expect.any(String) }));
    expect(pool).not.toHaveBeenCalled();
    await workers.stop();
  });

  it("treats an empty ASAFARIM_NATS_URL as no bus", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const workers = startWorkers({
      pool: () => Promise.reject(new Error("unused")),
      engine: {} as Engine,
      wake: vi.fn(),
      env: { ASAFARIM_NATS_URL: " , " },
    });
    expect(warn).toHaveBeenCalledWith("flow.subscribers.no_bus", expect.anything());
    await workers.stop();
  });

  it("has no relay: startAppRelay returns nothing and logs events.relay.no_bus", () => {
    const relayLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const relay = startAppRelay({
      appId: "flow",
      pool: () => Promise.reject(new Error("unused")),
      env: {},
      log: relayLog,
    });
    expect(relay).toBeUndefined();
    expect(relayLog.warn).toHaveBeenCalledWith("events.relay.no_bus", expect.objectContaining({ appId: "flow" }));
  });
});
