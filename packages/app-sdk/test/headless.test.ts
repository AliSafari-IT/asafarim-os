import { describe, expect, it } from "vitest";
import { createHeadlessAuth, HeadlessUnavailable } from "../src/headless.ts";

const SECRET = "s".repeat(40);
function fakeFetch(replies: Record<string, { status: number; body?: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = replies[new URL(String(url)).pathname] ?? { status: 404, body: { error: "not_found" } };
    return new Response(reply.body === undefined ? "oops" : JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { fn, calls };
}
const make = (replies: Record<string, { status: number; body?: unknown }>) => {
  const f = fakeFetch(replies);
  return {
    auth: createHeadlessAuth({
      issuer: "https://id.example.test",
      clientId: "breinhap",
      clientSecret: SECRET,
      fetch: f.fn,
    }),
    calls: f.calls,
  };
};

describe("@asafarim/app-sdk/headless", () => {
  it("starts and verifies an e-mail code with the app's secret, server to server", async () => {
    const { auth, calls } = make({
      "/headless/v1/email/start": { status: 202, body: { challenge: "c".repeat(22), expires_in: 300 } },
      "/headless/v1/email/verify": { status: 200, body: { sub: "p-1", email: "kim@example.test", connected: false } },
    });
    expect(
      await auth.startEmail({ email: "kim@example.test", locale: "nl", intent: "register", clientIp: "203.0.113.9" }),
    ).toEqual({ ok: true, challenge: "c".repeat(22), expiresIn: 300 });
    expect(await auth.verifyEmail({ challenge: "c".repeat(22), email: "kim@example.test", code: "123456" })).toEqual({
      ok: true,
      sub: "p-1",
      email: "kim@example.test",
      connected: false,
    });
    const [first] = calls;
    expect(first!.url).toBe("https://id.example.test/headless/v1/email/start");
    expect((first!.init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from(`breinhap:${SECRET}`).toString("base64")}`,
    );
    expect(JSON.parse(String(first!.init.body))).toEqual({
      email: "kim@example.test",
      locale: "nl",
      intent: "register",
      client_ip: "203.0.113.9",
    });
    expect(first!.init.redirect).toBe("error");
  });

  it("turns refusals into typed results, and an unreachable identity into 'unavailable'", async () => {
    const { auth } = make({
      "/headless/v1/email/start": { status: 429, body: { error: "cooldown", retry_after: 60 } },
      "/headless/v1/email/verify": { status: 403, body: { error: "not_connected" } },
      "/headless/v1/principal": { status: 500 },
    });
    expect(await auth.startEmail({ email: "x@example.test" })).toEqual({
      ok: false,
      error: "cooldown",
      retryAfter: 60,
    });
    expect(await auth.verifyEmail({ challenge: "c".repeat(22), email: "x@example.test", code: "1" })).toEqual({
      ok: false,
      error: "not_connected",
    });
    await expect(auth.principal("p-1")).rejects.toBeInstanceOf(HeadlessUnavailable);
    const broken = make({}).auth;
    expect(await broken.startEmail({ email: "x@example.test" })).toEqual({ ok: false, error: "not_found" });
  });

  it("refuses an insecure issuer or a weak secret", () => {
    expect(() =>
      createHeadlessAuth({ issuer: "http://id.example.test", clientId: "breinhap", clientSecret: SECRET }),
    ).toThrow(/https/);
    expect(() =>
      createHeadlessAuth({ issuer: "https://id.example.test", clientId: "breinhap", clientSecret: "short" }),
    ).toThrow(/32/);
    expect(() =>
      createHeadlessAuth({ issuer: "http://localhost:4010", clientId: "breinhap", clientSecret: SECRET }),
    ).not.toThrow();
  });
});
