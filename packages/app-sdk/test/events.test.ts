import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { parseNatsConnect } from "@asafarim/registry-protocol";
import { OUTBOX_SQL, busAuthFromEnv, createPublisher, startAppRelay } from "../src/events.ts";

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

  describe("busAuthFromEnv (the app's identity on the bus)", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const credential = `osk1.notes.0123456789ab.${privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url")}`;

    it("is the app id plus a fresh signed assertion on every call", () => {
      const auth = busAuthFromEnv("notes", { ASAFARIM_REGISTRY_CREDENTIAL: credential });
      expect(auth?.user).toBe("notes");
      const a = parseNatsConnect(auth!.pass());
      const b = parseNatsConnect(auth!.pass());
      expect(a?.keyId).toBe("notes.0123456789ab");
      expect(a!.nonce).not.toBe(b!.nonce);
    });

    it("a plain login from the environment wins (a bus without the callout)", () => {
      const auth = busAuthFromEnv("notes", {
        ASAFARIM_NATS_USER: "core",
        ASAFARIM_NATS_PASSWORD: "pw",
        ASAFARIM_REGISTRY_CREDENTIAL: credential,
      });
      expect(auth?.user).toBe("core");
      expect(auth?.pass()).toBe("pw");
    });

    it("is undefined without a credential (a bus that checks nobody)", () => {
      expect(busAuthFromEnv("notes", {})).toBeUndefined();
    });
  });
});
