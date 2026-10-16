/**
 * The SMS sign-in and the connections admin, driven route by route with
 * in-memory storage (test/fakes.ts). The Redis and Postgres implementations
 * are covered by sms.integration.test.ts; the OIDC round trip too.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/log.ts";
import { createSmsLogin, type SmsLogin } from "../src/sms-login.ts";
import {
  Browser,
  CapturingSender,
  MemoryChallenges,
  MemoryFlows,
  MemoryLimiter,
  MemorySessions,
  MemoryStore,
  csrfOf,
  request,
} from "./fakes.ts";

const ADMIN = "+32470000001";
const OTHER = "+32470000002";
const SECRET = "o".repeat(40);

describe("SMS sign-in", () => {
  let store: MemoryStore;
  let sender: CapturingSender;
  let sessions: MemorySessions;
  let limiter: MemoryLimiter;
  let challenges: MemoryChallenges;
  let ended: string[];
  let logLines: string[];
  let sms: SmsLogin;

  beforeEach(async () => {
    store = new MemoryStore();
    sender = new CapturingSender();
    sessions = new MemorySessions();
    limiter = new MemoryLimiter();
    challenges = new MemoryChallenges();
    ended = [];
    logLines = [];
    await store.bootstrapAdmin(ADMIN);
    sms = createSmsLogin({
      issuer: "https://id.example.test",
      homeUrl: "https://home.example.test/",
      otpSecret: SECRET,
      allowedPrefixes: ["+32"],
      dailySmsLimit: 100,
      store,
      challenges,
      limits: limiter,
      sessions,
      flows: new MemoryFlows(),
      sender,
      endProviderSessions: async (id) => {
        ended.push(id);
        return 1;
      },
      log: createLogger((l) => logLines.push(l)),
    });
  });

  const go = (b: Browser, method: "GET" | "POST", url: string, form?: Record<string, string>) =>
    request((ctx) => sms.handle(ctx), b, method, url, form);

  /** Number → code → verify. Returns the verify reply. */
  async function signIn(b: Browser, phone: string, startUrl = "/login") {
    const start = await go(b, "GET", startUrl);
    expect(start.status).toBe(200);
    const csrf = csrfOf(start.body);
    const sent = await go(b, "POST", "/login/phone", { csrf, phone });
    expect(sent.status).toBe(303);
    expect(sent.location).toBe("/login/code");
    return go(b, "POST", "/login/verify", { csrf, code: sender.lastCode(phone) });
  }

  it("the QR code's /connect only starts a sign-in; it grants nothing", async () => {
    const b = new Browser();
    const res = await go(b, "GET", "/connect");
    expect(res.status).toBe(303);
    expect(res.location).toBe("/login");
    expect(await sms.authorizedPrincipal({ cookies: { get: () => undefined } } as never)).toBeNull();
    expect(b.cookies.size).toBe(0);
  });

  it("asks for the number with a CSRF-protected form, and refuses a forged or stale form", async () => {
    const b = new Browser();
    const page = await go(b, "GET", "/login");
    expect(page.body).toContain('autocomplete="tel"');
    expect(page.headers["content-security-policy"]).toContain("form-action 'self'");
    expect(page.headers["cache-control"]).toBe("no-store");
    const forged = await go(b, "POST", "/login/phone", { csrf: "nope", phone: ADMIN });
    expect(forged.status).toBe(400);
    expect(sender.sent).toHaveLength(0);
    const noFlow = await go(new Browser(), "POST", "/login/phone", { csrf: csrfOf(page.body), phone: ADMIN });
    expect(noFlow.status).toBe(400);
    expect(sender.sent).toHaveLength(0);
  });

  it("refuses numbers that aren't full international numbers, and countries not allowed", async () => {
    const b = new Browser();
    const csrf = csrfOf((await go(b, "GET", "/login")).body);
    expect((await go(b, "POST", "/login/phone", { csrf, phone: "0470 12 34 56" })).status).toBe(400);
    const foreign = await go(b, "POST", "/login/phone", { csrf, phone: "+44 7700 900123" });
    expect(foreign.status).toBe(400);
    expect(foreign.body).toContain("available for numbers in this country");
    expect(sender.sent).toHaveLength(0);
    expect(store.events()).toContain("otp.send_refused");
  });

  it("answers the number step the same way for a connected and an unknown number", async () => {
    const replies = [];
    for (const phone of [ADMIN, OTHER]) {
      const b = new Browser();
      const csrf = csrfOf((await go(b, "GET", "/login")).body);
      const sent = await go(b, "POST", "/login/phone", { csrf, phone });
      const code = await go(b, "GET", "/login/code");
      replies.push({
        status: sent.status,
        location: sent.location,
        code: code.status,
        page: code.body.replace(/value="[^"]+"/g, "").replace(/••• \d\d/, ""),
      });
    }
    expect(replies[0]).toEqual(replies[1]);
    expect(sender.sent.map((m) => m.to)).toEqual([ADMIN, OTHER]);
  });

  it("sends a 6-digit code bound to the site, and never logs the number or the code", async () => {
    const b = new Browser();
    const res = await signIn(b, ADMIN);
    expect(res.status).toBe(200);
    const [msg] = sender.sent;
    expect(msg!.body).toMatch(/^Your ASafariM sign-in code is \d{6}\./);
    expect(msg!.body).toMatch(/\n@id\.example\.test #\d{6}$/);
    const code = /\d{6}/.exec(msg!.body)![0];
    for (const line of logLines) {
      expect(line).not.toContain("470000001");
      expect(line).not.toContain(code);
    }
    for (const e of store.auditLog) expect(JSON.stringify(e)).not.toContain("470000001");
    for (const key of limiter.keys) expect(key).not.toContain("470000001");
  });

  it("a connected number signs in and continues; the session is authorized server-side", async () => {
    const b = new Browser();
    const res = await signIn(b, ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toContain('content="0;url=https://home.example.test/"');
    expect(res.location).toBeUndefined(); // a page, not a redirect (form-action applies to redirects)
    expect(b.cookies.has("identity_auth")).toBe(true);
    expect(b.cookies.has("identity_login")).toBe(false); // the flow is spent
    expect(store.events()).toEqual(expect.arrayContaining(["otp.sent", "otp.verified", "login.granted"]));
  });

  it("a verified but unconnected number gets no access, only 'Request connection'", async () => {
    const b = new Browser();
    const res = await signIn(b, OTHER);
    expect(res.status).toBe(303);
    expect(res.location).toBe("/login");
    const page = await go(b, "GET", "/login");
    expect(page.body).toContain("Not connected yet");
    expect(page.body).toContain('action="/login/request"');
    expect(store.events()).toContain("login.not_authorized");
    expect(store.events()).not.toContain("login.granted");
  });

  it("a connection request stays pending until an admin approves it; then the number signs in", async () => {
    const user = new Browser();
    await signIn(user, OTHER);
    const csrf = csrfOf((await go(user, "GET", "/login")).body);
    const asked = await go(user, "POST", "/login/request", { csrf });
    expect(asked.body).toContain("Request pending");
    await go(user, "POST", "/login/request", { csrf }); // twice: still one request
    expect(await store.pendingRequests()).toHaveLength(1);
    // Still no access while pending.
    expect((await go(user, "GET", "/login")).body).toContain("Request pending");

    const admin = new Browser();
    await signIn(admin, ADMIN, "/login?next=admin");
    const panel = await go(admin, "GET", "/admin");
    expect(panel.status).toBe(200);
    expect(panel.body).toContain(OTHER);
    const [pending] = await store.pendingRequests();
    const approveUrl = `/admin/requests/${pending!.id}/approve`;
    expect((await go(admin, "POST", approveUrl, { csrf: "forged" })).status).toBe(400);
    const approved = await go(admin, "POST", approveUrl, { csrf: csrfOf(panel.body) });
    expect(approved.status).toBe(303);
    expect(approved.location).toBe("/admin?done=approved");
    expect(store.events()).toContain("request.approved");

    // The user's existing session is now authorized, read fresh from the store.
    const again = await go(user, "GET", "/login");
    expect(again.status).toBe(303);
    expect(again.location).toBe("https://home.example.test/");
  });

  it("a rejected request leaves the number unconnected", async () => {
    const user = new Browser();
    await signIn(user, OTHER);
    await go(user, "POST", "/login/request", { csrf: csrfOf((await go(user, "GET", "/login")).body) });
    const admin = new Browser();
    await signIn(admin, ADMIN);
    const csrf = csrfOf((await go(admin, "GET", "/admin")).body);
    const [pending] = await store.pendingRequests();
    const res = await go(admin, "POST", `/admin/requests/${pending!.id}/reject`, { csrf });
    expect(res.location).toBe("/admin?done=rejected");
    expect((await store.principal(pending!.principalId))!.connection).toBe("none");
    // Deciding it again does nothing.
    expect((await go(admin, "POST", `/admin/requests/${pending!.id}/approve`, { csrf })).location).toBe(
      "/admin?done=stale",
    );
  });

  it("revoking a connection ends that person's sessions at once", async () => {
    const admin = new Browser();
    await signIn(admin, ADMIN);
    const csrf = csrfOf((await go(admin, "GET", "/admin")).body);
    const added = await go(admin, "POST", "/admin/connections", { csrf, phone: "+32 470 00 00 02" });
    expect(added.location).toBe("/admin?done=added");

    const user = new Browser();
    await signIn(user, OTHER);
    const userId = (await store.connections()).find((c) => c.phone === OTHER)!.principalId;
    expect((await go(user, "GET", "/login")).status).toBe(303); // connected

    const revoked = await go(admin, "POST", `/admin/connections/${userId}/revoke`, { csrf });
    expect(revoked.location).toBe("/admin?done=revoked");
    expect(ended).toEqual([userId]);
    expect([...sessions.rows.values()].some((s) => s.principalId === userId)).toBe(false);
    // The old cookie is worthless; signing in again proves the number but grants nothing.
    expect((await go(user, "GET", "/login")).body).toContain("Mobile number");
    limiter.reset(); // the resend cooldown of the earlier sign-in
    expect((await signIn(user, OTHER)).location).toBe("/login");
  });

  it("an admin can't revoke themselves, and non-admins can't use the admin", async () => {
    const admin = new Browser();
    await signIn(admin, ADMIN);
    const csrf = csrfOf((await go(admin, "GET", "/admin")).body);
    const adminId = (await store.connections())[0]!.principalId;
    expect((await go(admin, "POST", `/admin/connections/${adminId}/revoke`, { csrf })).location).toBe(
      "/admin?done=self",
    );

    await store.addConnection(OTHER, adminId);
    const user = new Browser();
    await signIn(user, OTHER);
    expect((await go(user, "GET", "/admin")).status).toBe(403);
    const userCsrf = csrfOf((await go(user, "GET", "/login?fresh=1")).body);
    expect((await go(user, "POST", "/admin/connections", { csrf: userCsrf, phone: "+32470000009" })).status).toBe(403);
    expect(store.events()).toContain("admin.denied");
    expect((await go(new Browser(), "GET", "/admin")).location).toBe("/login?next=admin");
  });

  it("a code works once, and a wrong code counts against the challenge until it is gone", async () => {
    const b = new Browser();
    const csrf = csrfOf((await go(b, "GET", "/login")).body);
    await go(b, "POST", "/login/phone", { csrf, phone: ADMIN });
    const code = sender.lastCode(ADMIN);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 1; i < 5; i++) {
      const res = await go(b, "POST", "/login/verify", { csrf, code: wrong });
      expect(res.status).toBe(400);
      expect(res.body).toContain("Check the SMS and try again");
    }
    const fifth = await go(b, "POST", "/login/verify", { csrf, code: wrong });
    expect(fifth.body).toContain("too many wrong tries");
    // The right code no longer works: the challenge is gone.
    expect((await go(b, "POST", "/login/verify", { csrf, code })).body).toContain("no longer valid");

    limiter.reset();
    await go(b, "POST", "/login/resend", { csrf });
    const fresh = sender.lastCode(ADMIN);
    expect((await go(b, "POST", "/login/verify", { csrf, code: fresh })).status).toBe(200);
    // Replaying the same submission: the flow is spent.
    expect((await go(b, "POST", "/login/verify", { csrf, code: fresh })).status).toBe(400);
  });

  it("rate-limits sending: a resend cooldown, then a per-number window", async () => {
    const b = new Browser();
    const csrf = csrfOf((await go(b, "GET", "/login")).body);
    await go(b, "POST", "/login/phone", { csrf, phone: ADMIN });
    const tooSoon = await go(b, "POST", "/login/resend", { csrf });
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body).toContain("just sent");
    for (let i = 0; i < 2; i++) {
      limiter.cooldowns.clear();
      expect((await go(b, "POST", "/login/resend", { csrf })).status).toBe(303);
    }
    limiter.cooldowns.clear();
    const limited = await go(b, "POST", "/login/resend", { csrf });
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(sender.sent).toHaveLength(3);
  });

  it("rate-limits verifying per IP", async () => {
    const b = new Browser();
    const csrf = csrfOf((await go(b, "GET", "/login")).body);
    await go(b, "POST", "/login/phone", { csrf, phone: ADMIN });
    const key = [...limiter.counts.keys()].find((k) => k.startsWith("send-ip:"))!.replace("send-ip:", "verify-ip:");
    limiter.counts.set(key, 30);
    const res = await go(b, "POST", "/login/verify", { csrf, code: sender.lastCode(ADMIN) });
    expect(res.status).toBe(429);
    expect(store.events()).toContain("otp.verify_refused");
  });

  it("a failed SMS send is reported without saying whether the number is known", async () => {
    sender.fail = true;
    const b = new Browser();
    const csrf = csrfOf((await go(b, "GET", "/login")).body);
    const res = await go(b, "POST", "/login/phone", { csrf, phone: ADMIN });
    expect(res.status).toBe(503);
    expect(res.body).toContain("send a code right now");
    expect(store.events()).toContain("otp.send_failed");
  });

  it("an OIDC sign-in continues to its interaction; fresh=1 ignores an existing session", async () => {
    const b = new Browser();
    const res = await signIn(b, ADMIN, "/login?uid=abc_DEF-123");
    expect(res.body).toContain('content="0;url=/interaction/abc_DEF-123"');
    // Already signed in: straight back to the interaction.
    expect((await go(b, "GET", "/login?uid=abc_DEF-123")).location).toBe("/interaction/abc_DEF-123");
    // The app asked for a new sign-in: the number form again.
    expect((await go(b, "GET", "/login?uid=abc_DEF-123&fresh=1")).body).toContain("Mobile number");
    // A uid that isn't one can't steer the redirect.
    limiter.reset();
    const odd = await signIn(new Browser(), ADMIN, "/login?uid=https://evil.example/x");
    expect(odd.body).toContain('content="0;url=https://home.example.test/"');
  });

  it("signing out ends the session", async () => {
    const b = new Browser();
    await signIn(b, ADMIN);
    const csrf = csrfOf((await go(b, "GET", "/admin")).body);
    const out = await go(b, "POST", "/logout", { csrf });
    expect(out.body).toContain("Signed out");
    expect(sessions.rows.size).toBe(0);
    expect(b.cookies.has("identity_auth")).toBe(false);
  });

  it("leaves every other path to the provider", async () => {
    for (const [m, p] of [
      ["GET", "/auth"],
      ["GET", "/interaction/x"],
      ["POST", "/token"],
      ["GET", "/admin/other"],
    ] as const) {
      expect((await go(new Browser(), m, p)).handled).toBe(false);
    }
  });
});
