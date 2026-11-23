import { describe, expect, it } from "vitest";
import { clientKey } from "../lib/rate-limit";

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n] ?? null });

describe("clientKey", () => {
  it("keys on the address the gateway appended, not ones the client sent", () => {
    expect(clientKey(headers({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }))).toBe("1.2.3.4");
    expect(clientKey(headers({ "x-forwarded-for": "1.2.3.4" }))).toBe("1.2.3.4");
  });

  it("falls back to X-Real-IP, then one shared key", () => {
    expect(clientKey(headers({ "x-real-ip": "5.5.5.5" }))).toBe("5.5.5.5");
    expect(clientKey(headers({}))).toBe("unknown");
  });
});
