import { describe, expect, it } from "vitest";
import { clientAddress, visitorHash, visitorHashOf } from "../src/visitor.ts";

const headers = (h: Record<string, string>) => ({
  get: (n: string) => h[n.toLowerCase()] ?? null,
});

const SALT = "a-test-salt-of-16+chars";

describe("clientAddress", () => {
  it("uses the LAST X-Forwarded-For entry: the one the gateway appended, not the forgeable ones before it", () => {
    expect(clientAddress(headers({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }))).toBe("1.2.3.4");
    expect(clientAddress(headers({ "x-forwarded-for": "1.2.3.4" }))).toBe("1.2.3.4");
  });

  it("falls back to X-Real-IP, then to one shared key", () => {
    expect(clientAddress(headers({ "x-real-ip": "5.5.5.5" }))).toBe("5.5.5.5");
    expect(clientAddress(headers({}))).toBe("unknown");
  });
});

describe("visitorHash", () => {
  const base = { ip: "1.2.3.4", userAgent: "Mozilla/5.0", salt: SALT };

  it("is 64 lower-case hex characters and deterministic", () => {
    expect(visitorHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(visitorHash(base)).toBe(visitorHash({ ...base }));
  });

  it("differs by address, User-Agent and salt", () => {
    const h = visitorHash(base);
    expect(visitorHash({ ...base, ip: "1.2.3.5" })).not.toBe(h);
    expect(visitorHash({ ...base, userAgent: "curl/8" })).not.toBe(h);
    expect(visitorHash({ ...base, salt: "another-salt-16-chars" })).not.toBe(h);
  });

  it("does not let a shifted boundary collide (ip|ua is delimited)", () => {
    expect(visitorHash({ ...base, ip: "1.2.3.4", userAgent: "5x" })).not.toBe(
      visitorHash({ ...base, ip: "1.2.3.45", userAgent: "x" }),
    );
  });

  it("refuses a missing or short salt (fail closed)", () => {
    expect(() => visitorHash({ ...base, salt: "" })).toThrow(/ENGAGEMENT_SALT/);
    expect(() => visitorHash({ ...base, salt: "short" })).toThrow(/ENGAGEMENT_SALT/);
    expect(() => visitorHash({ ...base, salt: undefined as unknown as string })).toThrow(/ENGAGEMENT_SALT/);
  });

  it("treats a missing User-Agent as empty", () => {
    expect(visitorHash({ ...base, userAgent: null })).toBe(visitorHash({ ...base, userAgent: "" }));
  });
});

describe("visitorHashOf", () => {
  it("ignores forged X-Forwarded-For entries to the left of the gateway's", () => {
    const a = visitorHashOf(headers({ "x-forwarded-for": "9.9.9.9, 1.2.3.4", "user-agent": "ua" }), SALT);
    const b = visitorHashOf(headers({ "x-forwarded-for": "8.8.8.8, 1.2.3.4", "user-agent": "ua" }), SALT);
    expect(a).toBe(b);
  });
});
