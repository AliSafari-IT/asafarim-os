import { describe, expect, it } from "vitest";
import {
  AuthRuntimeError,
  InvalidConfigError,
  InvalidReturnTargetError,
  StepUpRequiredError,
  clearCookie,
  defaultBounds,
  isFresh,
  MIN_FRESH_MS,
  newId,
  readCookie,
  resolveBounds,
  safeReturnTarget,
  serializeCookie,
  validateReturnTarget,
} from "../src/index.ts";

const origin = "https://app.example";

describe("unit: bounds", () => {
  it("are required: there is no implicit default", () => {
    expect(() => resolveBounds(undefined)).toThrow(InvalidConfigError);
  });
  it("the example constant resolves to identity's own numbers", () => {
    expect(resolveBounds(defaultBounds)).toMatchObject({
      absoluteMs: 43_200_000,
      idleMs: 1_800_000,
      freshMs: 300_000,
      revalidateMs: 60_000,
    });
  });
  it("accept exactly the minimum step-up window", () => {
    expect(MIN_FRESH_MS).toBe(120_000);
    expect(
      resolveBounds({ absoluteMs: 1_000_000, idleMs: null, freshMs: MIN_FRESH_MS, revalidateMs: 60_000 }).freshMs,
    ).toBe(120_000);
  });
  it("refuse nonsense and unordered values", () => {
    const ok = { absoluteMs: 1_000_000, idleMs: 500_000, freshMs: 150_000, revalidateMs: 50_000 };
    expect(resolveBounds(ok).idleMs).toBe(500_000);
    expect(resolveBounds({ ...ok, idleMs: null }).idleMs).toBeNull();
    for (const bad of [
      { ...ok, absoluteMs: 0 },
      { ...ok, absoluteMs: Number.NaN },
      { ...ok, idleMs: -1 },
      { ...ok, idleMs: 2_000_000 },
      { ...ok, freshMs: 2_000_000 },
      { ...ok, freshMs: 119_999 }, // below identity's 120 s login reuse window
      { ...ok, freshMs: 1000 },
      { ...ok, revalidateMs: 2_000_000 },
      { ...ok, revalidateMs: 0 },
      { ...ok, refreshSkewMs: -1 },
      { ...ok, refreshLeaseMs: 0 },
    ])
      expect(() => resolveBounds(bad), JSON.stringify(bad)).toThrow(InvalidConfigError);
  });
});

describe("unit: isFresh (auth_time from the verified ID token)", () => {
  const now = Date.UTC(2026, 10, 7, 10, 0, 0);
  const s = now / 1000;
  it("is fresh inside the bound and stale outside", () => {
    expect(isFresh(s - 299, now, 300_000)).toBe(true);
    expect(isFresh(s - 300, now, 300_000)).toBe(true);
    expect(isFresh(s - 301, now, 300_000)).toBe(false);
  });
  it("is never fresh for a missing, non-numeric, zero or future auth_time", () => {
    for (const v of [undefined, null, "123", Number.NaN, Infinity, 0, -5, s + 6, s + 3600])
      expect(isFresh(v, now, 300_000)).toBe(false);
    expect(isFresh(s + 4, now, 300_000)).toBe(true); // small skew
  });
});

describe("unit: return targets", () => {
  const opts = { origin, allowedOrigins: ["https://www.example"] };
  it("accepts same-origin relative paths and normalises them", () => {
    expect(validateReturnTarget("/", opts)).toBe("/");
    expect(validateReturnTarget("/a/b?x=1#h", opts)).toBe("/a/b?x=1#h");
    expect(validateReturnTarget("/a/../b", opts)).toBe("/b");
  });
  it("accepts an absolute URL only for a configured origin, exactly", () => {
    expect(validateReturnTarget("https://app.example/x", opts)).toBe("https://app.example/x");
    expect(validateReturnTarget("https://www.example/x?y=1", opts)).toBe("https://www.example/x?y=1");
  });
  it.each([
    ["protocol-relative", "//evil.example/x"],
    ["triple slash", "///evil.example"],
    ["backslash", "/\\evil.example"],
    ["backslash host", "\\\\evil.example"],
    ["other origin", "https://evil.example/x"],
    ["suffix spoof", "https://app.example.evil.example/"],
    ["prefix spoof", "https://evil.example/https://app.example/"],
    ["userinfo", "https://app.example@evil.example/"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,x"],
    ["scheme-less host", "evil.example/x"],
    ["relative without slash", "x/y"],
    ["http downgrade", "http://app.example/x"],
    ["control character", "/x\ny"],
    ["tab", "/x\ty"],
    ["null byte", "/x\u0000y"],
    ["empty", ""],
    ["too long", "/" + "a".repeat(600)],
    ["not a string", 5],
    ["undefined", undefined],
  ])("refuses %s", (_label, target) => {
    expect(() => validateReturnTarget(target, opts)).toThrow(InvalidReturnTargetError);
    expect(safeReturnTarget(target, opts, "/home")).toBe("/home");
  });
});

describe("unit: cookies", () => {
  const id = newId();
  it("ids are 43 base64url characters and differ", () => {
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newId()).not.toBe(id);
  });
  it("serialises a host-only cookie: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain", () => {
    const c = serializeCookie("__Host-s", id, { maxAgeSec: 90.7 });
    expect(c).toBe(`__Host-s=${id}; Max-Age=90; Path=/; Secure; HttpOnly; SameSite=Lax`);
    expect(c).not.toMatch(/domain/i);
    expect(clearCookie("__Host-s")).toContain("Max-Age=0");
  });
  it("refuses a name without the __Host- prefix and a value that is not an id", () => {
    expect(() => serializeCookie("session", id, { maxAgeSec: 1 })).toThrow(InvalidConfigError);
    expect(() => serializeCookie("__Host-s", "has space", { maxAgeSec: 1 })).toThrow(InvalidConfigError);
    expect(() => serializeCookie("__Host-s", id, { maxAgeSec: Number.NaN })).toThrow(InvalidConfigError);
  });
  it("reads one matching cookie, and nothing when it is duplicated, malformed or absent", () => {
    expect(readCookie(`a=1; __Host-s=${id}; b=2`, "__Host-s")).toBe(id);
    expect(readCookie(`__Host-s=${id}; __Host-s=${newId()}`, "__Host-s")).toBeUndefined();
    expect(readCookie("__Host-s=short", "__Host-s")).toBeUndefined();
    expect(readCookie(`x__Host-s=${id}`, "__Host-s")).toBeUndefined();
    expect(readCookie(undefined, "__Host-s")).toBeUndefined();
    expect(readCookie("", "__Host-s")).toBeUndefined();
  });
});

describe("unit: typed errors never carry inputs", () => {
  it("serialise to code, status and a closed reason only", () => {
    const e = new StepUpRequiredError("/auth/start?fresh=1");
    expect(e).toBeInstanceOf(AuthRuntimeError);
    expect(e.toJSON()).toEqual({
      name: "StepUpRequiredError",
      code: "step_up_required",
      status: 401,
      restartUrl: "/auth/start?fresh=1",
    });
    expect(new InvalidReturnTargetError().message).not.toMatch(/http|\//);
  });
});
