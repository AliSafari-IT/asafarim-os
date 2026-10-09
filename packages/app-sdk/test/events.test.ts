import { describe, expect, it } from "vitest";
import { OUTBOX_SQL, createPublisher, startAppRelay } from "../src/events.ts";

const pool = {
  connect: async () => {
    throw new Error("not used");
  },
};

describe("@asafarim/app-sdk/events", () => {
  it("re-exports @asafarim/events", () => {
    expect(OUTBOX_SQL).toMatch(/CREATE TABLE IF NOT EXISTS asafarim_outbox/);
    expect(typeof createPublisher).toBe("function");
  });

  it("without ASAFARIM_NATS_URL: no relay, one warning naming the variable", () => {
    const warnings: { msg: string; detail?: object }[] = [];
    const relay = startAppRelay({
      appId: "notes",
      pool,
      env: {},
      log: { info: () => undefined, warn: (msg, detail) => warnings.push({ msg, detail }) },
    });
    expect(relay).toBeUndefined();
    expect(warnings).toEqual([
      {
        msg: "events.relay.no_bus",
        detail: expect.objectContaining({ appId: "notes", hint: expect.stringMatching(/ASAFARIM_NATS_URL/) }),
      },
    ]);
  });

  it("with ASAFARIM_NATS_URL: a relay that stops cleanly", async () => {
    const relay = startAppRelay({
      appId: "notes",
      pool,
      env: { ASAFARIM_NATS_URL: " nats://127.0.0.1:1 , " },
      autoStart: false,
      log: { info: () => undefined, warn: () => undefined },
    });
    expect(relay).toBeDefined();
    await relay!.stop();
  });
});
