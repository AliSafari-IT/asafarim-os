import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseCredential } from "./index.ts";
import { natsConnectCanonical, natsInboxPrefix, parseNatsConnect, signNatsConnect } from "./nats-connect.ts";

function credential(appId: string) {
  const { privateKey } = generateKeyPairSync("ed25519");
  return `osk1.${appId}.0123456789ab.${privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url")}`;
}

describe("signNatsConnect / parseNatsConnect", () => {
  const cred = credential("notes");
  const now = new Date("2026-10-09T12:00:00Z");

  it("round-trips: the parts match what was signed", () => {
    const pass = signNatsConnect({ appId: "notes", credential: cred, now, nonce: "n".repeat(24) });
    const parsed = parseNatsConnect(pass);
    expect(parsed).toMatchObject({
      keyId: "notes.0123456789ab",
      timestamp: String(now.getTime() / 1000),
      nonce: "n".repeat(24),
    });
    expect(parsed!.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseCredential(cred).keyId).toBe(parsed!.keyId);
  });

  it("uses a fresh nonce each time", () => {
    const a = parseNatsConnect(signNatsConnect({ appId: "notes", credential: cred }));
    const b = parseNatsConnect(signNatsConnect({ appId: "notes", credential: cred }));
    expect(a!.nonce).not.toBe(b!.nonce);
  });

  it("refuses to sign with another app's credential", () => {
    expect(() => signNatsConnect({ appId: "tasks", credential: cred })).toThrow(/isn't for app "tasks"/);
  });

  it("has a canonical string that binds the app, the time and the nonce", () => {
    expect(natsConnectCanonical("notes", "1", "abc")).toBe("nats-connect\nnotes\n1\nabc");
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["wrong version", "v2.notes.0123456789ab.1.nnnnnnnnnnnnnnnnnnnnnn.ssssssssssssssssssss"],
    ["too few parts", "v1.notes.0123456789ab.1"],
    ["bad key id", "v1.NOTES.zz.1.nnnnnnnnnnnnnnnnnnnnnn.ssssssssssssssssssss"],
    ["non-numeric timestamp", "v1.notes.0123456789ab.abc.nnnnnnnnnnnnnnnnnnnnnn.ssssssssssssssssssss"],
    ["short nonce", "v1.notes.0123456789ab.1.short.ssssssssssssssssssss"],
    ["short signature", "v1.notes.0123456789ab.1.nnnnnnnnnnnnnnnnnnnnnn.sig"],
    ["too long", `v1.notes.0123456789ab.1.nnnnnnnnnnnnnnnnnnnnnn.${"s".repeat(600)}`],
  ])("rejects a malformed assertion: %s", (_name, pass) => {
    expect(parseNatsConnect(pass)).toBeUndefined();
  });
});

describe("natsInboxPrefix", () => {
  it("is per app, and the subscription's trailing dot keeps one app's prefix from matching another's", () => {
    expect(natsInboxPrefix("notes")).toBe("_INBOX_notes");
    expect(`${natsInboxPrefix("notes")}.>`).not.toBe(`${natsInboxPrefix("notesx")}.>`);
    expect(`${natsInboxPrefix("notesx")}.abc`.startsWith(`${natsInboxPrefix("notes")}.`)).toBe(false);
  });
});
