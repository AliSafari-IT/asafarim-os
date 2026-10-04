import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NONCE_PATTERN, SIGNATURE_WINDOW_SECONDS, canonicalString, parseCredential, signRequest } from "./index.ts";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function credential() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = "notes.0123456789ab";
  return {
    keyId,
    publicKey,
    secret: `osk1.${keyId}.${privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url")}`,
  };
}

function verifies(publicKey: KeyObject, headers: Record<string, string>, method: string, path: string, body = "") {
  const sig = /^v1=(.+)$/.exec(headers["x-asafarim-signature"]!)![1]!;
  const message = canonicalString(headers["x-asafarim-timestamp"]!, headers["x-asafarim-nonce"]!, method, path, body);
  return verify(null, Buffer.from(message), publicKey, Buffer.from(sig, "base64url"));
}

describe("canonicalString", () => {
  it("is exactly v1, timestamp, nonce, METHOD, path and the body's SHA-256, one per line (a fixed vector)", () => {
    expect(
      canonicalString("1791120000", "n".repeat(22), "get", "/registry/v1/apps/notes/subjects/dev-member", ""),
    ).toBe(`v1\n1791120000\n${"n".repeat(22)}\nGET\n/registry/v1/apps/notes/subjects/dev-member\n${EMPTY_SHA256}`);
  });

  it("hashes the exact body", () => {
    const a = canonicalString("1", "n", "POST", "/p", '{"a":1}');
    const b = canonicalString("1", "n", "POST", "/p", '{"a": 1}');
    expect(a).not.toBe(b);
  });
});

describe("signRequest", () => {
  it("returns the four headers, a fresh nonce each call, and a timestamp in seconds", () => {
    const c = credential();
    const now = new Date("2026-10-04T12:00:00Z");
    const a = signRequest({ credential: c.secret, method: "POST", path: "/registry/v1/apps/notes", body: "{}", now });
    const b = signRequest({ credential: c.secret, method: "POST", path: "/registry/v1/apps/notes", body: "{}", now });
    expect(Object.keys(a).sort()).toEqual([
      "x-asafarim-key-id",
      "x-asafarim-nonce",
      "x-asafarim-signature",
      "x-asafarim-timestamp",
    ]);
    expect(a["x-asafarim-timestamp"]).toBe(String(Math.floor(now.getTime() / 1000)));
    expect(a["x-asafarim-key-id"]).toBe(c.keyId);
    expect(a["x-asafarim-nonce"]).toMatch(NONCE_PATTERN);
    expect(a["x-asafarim-nonce"]).not.toBe(b["x-asafarim-nonce"]);
  });

  it("the signature verifies with the public key, and with nothing that differs in method, path or body", () => {
    const c = credential();
    const h = signRequest({ credential: c.secret, method: "POST", path: "/registry/v1/apps/notes", body: '{"x":1}' });
    expect(verifies(c.publicKey, h, "POST", "/registry/v1/apps/notes", '{"x":1}')).toBe(true);
    expect(verifies(c.publicKey, h, "GET", "/registry/v1/apps/notes", '{"x":1}')).toBe(false);
    expect(verifies(c.publicKey, h, "POST", "/registry/v1/apps/other", '{"x":1}')).toBe(false);
    expect(verifies(c.publicKey, h, "POST", "/registry/v1/apps/notes", '{"x":2}')).toBe(false);
    expect(verifies(credential().publicKey, h, "POST", "/registry/v1/apps/notes", '{"x":1}')).toBe(false); // another key
  });

  it("an empty body is the default, and the method is case-insensitive", () => {
    const c = credential();
    const h = signRequest({ credential: c.secret, method: "get", path: "/x" });
    expect(verifies(c.publicKey, h, "GET", "/x", "")).toBe(true);
  });
});

describe("parseCredential", () => {
  it("reads the key id and key out of an osk1 credential", () => {
    const c = credential();
    const parsed = parseCredential(c.secret);
    expect(parsed.keyId).toBe(c.keyId);
    expect(parsed.privateKeyDer.length).toBeGreaterThan(30);
  });

  it("refuses anything else", () => {
    for (const bad of [
      "",
      "osk1.",
      "osk2.notes.0123456789ab.AAAA",
      "osk1.NOTES.0123456789ab.AAAA",
      "osk1.notes.xyz.AAAA",
      "notes",
    ]) {
      expect(() => parseCredential(bad), bad).toThrow(/registry credential/);
    }
  });
});

describe("constants", () => {
  it("the signature window is 60 s and a nonce is 22–128 base64url characters", () => {
    expect(SIGNATURE_WINDOW_SECONDS).toBe(60);
    expect(NONCE_PATTERN.test("a".repeat(21))).toBe(false);
    expect(NONCE_PATTERN.test("a".repeat(22))).toBe(true);
    expect(NONCE_PATTERN.test("a".repeat(129))).toBe(false);
    expect(NONCE_PATTERN.test("has space has space has")).toBe(false);
  });
});
