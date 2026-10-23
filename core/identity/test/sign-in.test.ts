/**
 * The local sign-in (email codes, passkeys, SMS) and the connections admin, driven route by route
 * with in-memory storage (test/fakes.ts). The Redis and Postgres pieces and the OIDC round trip
 * are in sign-in.integration.test.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/log.ts";
import { type SignIn, createSignIn, initialsOf } from "../src/sign-in.ts";
import { SoftPasskey } from "./authenticator.ts";
import {
  Browser,
  CapturingMailer,
  CapturingSender,
  MemoryChallenges,
  MemoryEphemeral,
  MemoryFlows,
  MemoryLimiter,
  MemorySessions,
  MemoryStore,
  csrfOf,
  request,
} from "./fakes.ts";

const ADMIN = "ali@example.test";
const OTHER = "someone@example.test";
const PHONE = "+32470000002";
const ISSUER = "https://id.example.test";
const RP = { id: "id.example.test", origin: ISSUER, name: "ASafariM" };

describe("local sign-in", () => {
  let store: MemoryStore;
  let mailer: CapturingMailer;
  let sms: CapturingSender;
  let sessions: MemorySessions;
  let limiter: MemoryLimiter;
  let ended: string[];
  let logLines: string[];
  let signIn: SignIn;

  beforeEach(async () => {
    store = new MemoryStore();
    mailer = new CapturingMailer();
    sms = new CapturingSender();
    sessions = new MemorySessions();
    limiter = new MemoryLimiter();
    ended = [];
    logLines = [];
    await store.bootstrapAdmin([{ method: "email", identifier: ADMIN }]);
    signIn = createSignIn({
      issuer: ISSUER,
      homeUrl: "https://home.example.test/",
      otpSecret: "o".repeat(40),
      email: { mailer, dailyLimit: 100 },
      sms: { sender: sms, allowedPrefixes: ["+32"], dailyLimit: 100 },
      passkeys: { rp: RP },
      ephemeral: new MemoryEphemeral(),
      store,
      challenges: new MemoryChallenges(),
      limits: limiter,
      sessions,
      flows: new MemoryFlows(),
      endProviderSessions: async (id) => {
        ended.push(id);
        return 1;
      },
      log: createLogger((l) => logLines.push(l)),
    });
  });

  const go = (
    b: Browser,
    method: "GET" | "POST",
    url: string,
    form?: Record<string, string>,
    opts?: { json?: unknown; headers?: Record<string, string> },
  ) => request((ctx) => signIn.handle(ctx), b, method, url, form, opts);

  /** Email → code → verify. Returns the verify reply. */
  async function emailSignIn(b: Browser, email: string, startUrl = "/login") {
    const start = await go(b, "GET", startUrl);
    expect(start.status).toBe(200);
    const csrf = csrfOf(start.body);
    const sent = await go(b, "POST", "/login/start", { csrf, via: "email", identifier: email });
    expect(sent.location).toBe("/login/code");
    return go(b, "POST", "/login/verify", { csrf, code: mailer.lastCode(email) });
  }

  it("the login page offers a passkey and an email code, and only our own script", async () => {
    const page = await go(new Browser(), "GET", "/login");
    expect(page.body).toContain('data-passkey="login"');
    expect(page.body).toContain('autocomplete="email"');
    expect(page.body).toContain('<script src="/static/passkey.js" defer></script>');
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    const js = await go(new Browser(), "GET", "/static/passkey.js");
    expect(js.status).toBe(200);
    expect(js.body).toContain("navigator.credentials");
  });

  it("the site root goes to the account page, and from there a signed-out visitor to sign in", async () => {
    const b = new Browser();
    const root = await go(b, "GET", "/");
    expect(root.status).toBe(303);
    expect(root.location).toBe("/account");
    expect((await go(b, "GET", "/account")).location).toBe("/login");
    expect(b.cookies.size).toBe(0);
  });

  it("the account page shows the account id: the principal id apps see as sub, for an admin's grants", async () => {
    const b = new Browser();
    await emailSignIn(b, ADMIN);
    const page = (await go(b, "GET", "/account")).body;
    const id = /<code data-account-id>([^<]+)<\/code>/.exec(page)?.[1];
    expect(id).toBeTruthy();
    expect((await store.principal(id!))?.id).toBe(id);
  });

  it("/whoami: signed out, or who is signed in; CORS only for the home page's origin", async () => {
    const out = await go(new Browser(), "GET", "/whoami", undefined, {
      headers: { origin: "https://home.example.test" },
    });
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ signedIn: false });
    expect(out.headers["access-control-allow-origin"]).toBe("https://home.example.test");
    expect(out.headers["access-control-allow-credentials"]).toBe("true");
    expect(out.headers["cache-control"]).toBe("no-store");

    const b = new Browser();
    await emailSignIn(b, ADMIN);
    const me = await go(b, "GET", "/whoami", undefined, { headers: { origin: "https://home.example.test" } });
    expect(JSON.parse(me.body)).toEqual({ signedIn: true, label: ADMIN, initials: "AL", connected: true });
    expect(me.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // never the principal id

    const evil = await go(b, "GET", "/whoami", undefined, { headers: { origin: "https://evil.example" } });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    expect(evil.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("initials for an avatar: two words, or the first two letters; a phone number is #", () => {
    expect(initialsOf("ali.safari@example.test")).toBe("AS");
    expect(initialsOf("ali@example.test")).toBe("AL");
    expect(initialsOf("+32470000002")).toBe("#");
    expect(initialsOf(null)).toBe("?");
  });

  it("the QR code's /connect only starts a sign-in", async () => {
    const b = new Browser();
    const res = await go(b, "GET", "/connect");
    expect(res.location).toBe("/login");
    expect(b.cookies.size).toBe(0);
  });

  it("emails a 6-digit code, signs a connected address in, and never logs the address or code", async () => {
    const b = new Browser();
    const res = await emailSignIn(b, ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toContain('content="0;url=https://home.example.test/"');
    const [msg] = mailer.sent;
    expect(msg!.subject).toMatch(/^Your ASafariM sign-in code: \d{6}$/);
    const code = /\d{6}/.exec(msg!.text)![0];
    for (const line of logLines) {
      expect(line).not.toContain("ali@");
      expect(line).not.toContain(code);
    }
    for (const key of limiter.keys) expect(key).not.toContain("ali@");
    expect(store.events()).toEqual(expect.arrayContaining(["otp.sent", "otp.verified", "login.granted"]));
  });

  it("answers the address step the same way for a connected and an unknown address", async () => {
    const replies = [];
    for (const email of [ADMIN, OTHER]) {
      const b = new Browser();
      const csrf = csrfOf((await go(b, "GET", "/login")).body);
      const sent = await go(b, "POST", "/login/start", { csrf, via: "email", identifier: email });
      const code = await go(b, "GET", "/login/code");
      replies.push({
        status: sent.status,
        location: sent.location,
        page: code.body.replace(/value="[^"]+"/g, "").replace(/<strong>[^<]+<\/strong>/, ""),
      });
    }
    expect(replies[0]).toEqual(replies[1]);
  });

  it("refuses a forged form and a bad address", async () => {
    const b = new Browser();
    const csrf = csrfOf((await go(b, "GET", "/login")).body);
    expect((await go(b, "POST", "/login/start", { csrf: "x", via: "email", identifier: ADMIN })).status).toBe(400);
    expect((await go(b, "POST", "/login/start", { csrf, via: "email", identifier: "not-an-email" })).status).toBe(400);
    expect(mailer.sent).toHaveLength(0);
  });

  it("an unconnected address gets no access, then is connected once an admin approves", async () => {
    const user = new Browser();
    const res = await emailSignIn(user, OTHER);
    expect(res.location).toBe("/login");
    const csrf = csrfOf((await go(user, "GET", "/login")).body);
    expect((await go(user, "POST", "/login/request", { csrf })).body).toContain("Request pending");

    const admin = new Browser();
    await emailSignIn(admin, ADMIN, "/login?next=admin");
    const panel = await go(admin, "GET", "/admin");
    expect(panel.body).toContain(OTHER);
    const [pending] = await store.pendingRequests();
    const approved = await go(admin, "POST", `/admin/requests/${pending!.id}/approve`, { csrf: csrfOf(panel.body) });
    expect(approved.location).toBe("/admin?done=approved");
    expect((await go(user, "GET", "/login")).location).toBe("https://home.example.test/");
  });

  it("an admin connects an email or a phone number, and revoking ends that person's sessions", async () => {
    const admin = new Browser();
    await emailSignIn(admin, ADMIN);
    const csrf = csrfOf((await go(admin, "GET", "/admin")).body);
    expect((await go(admin, "POST", "/admin/connections", { csrf, identifier: "Someone@Example.test" })).location).toBe(
      "/admin?done=added",
    );
    expect((await go(admin, "POST", "/admin/connections", { csrf, identifier: "+32 470 00 00 02" })).location).toBe(
      "/admin?done=added",
    );
    expect((await go(admin, "POST", "/admin/connections", { csrf, identifier: "nonsense" })).status).toBe(400);

    const user = new Browser();
    await emailSignIn(user, OTHER);
    const userId = (await store.connections()).find((c) => c.label === OTHER)!.principalId;
    expect((await go(admin, "POST", `/admin/connections/${userId}/revoke`, { csrf })).location).toBe(
      "/admin?done=revoked",
    );
    expect(ended).toEqual([userId]);
    expect((await go(user, "GET", "/login")).body).toContain("Email address");
  });

  it("non-admins can't use the admin", async () => {
    await store.addConnection("email", OTHER, "x");
    const user = new Browser();
    await emailSignIn(user, OTHER);
    expect((await go(user, "GET", "/admin")).status).toBe(403);
    expect(store.events()).toContain("admin.denied");
  });

  it("a code works once; wrong codes count until the code is gone", async () => {
    const b = new Browser();
    const csrf = csrfOf((await go(b, "GET", "/login")).body);
    await go(b, "POST", "/login/start", { csrf, via: "email", identifier: ADMIN });
    const code = mailer.lastCode(ADMIN);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 1; i < 5; i++) expect((await go(b, "POST", "/login/verify", { csrf, code: wrong })).status).toBe(400);
    expect((await go(b, "POST", "/login/verify", { csrf, code: wrong })).body).toContain("too many wrong tries");
    expect((await go(b, "POST", "/login/verify", { csrf, code })).body).toContain("no longer valid");
  });

  it("rate-limits sending: a resend cooldown, then a per-address window", async () => {
    const b = new Browser();
    const csrf = csrfOf((await go(b, "GET", "/login")).body);
    await go(b, "POST", "/login/start", { csrf, via: "email", identifier: ADMIN });
    expect((await go(b, "POST", "/login/resend", { csrf })).status).toBe(429);
    for (let i = 0; i < 2; i++) {
      limiter.cooldowns.clear();
      expect((await go(b, "POST", "/login/resend", { csrf })).status).toBe(303);
    }
    limiter.cooldowns.clear();
    expect((await go(b, "POST", "/login/resend", { csrf })).status).toBe(429);
    expect(mailer.sent).toHaveLength(3);
  });

  it("SMS codes still work when SMS is on", async () => {
    await store.addConnection("phone", PHONE, "x");
    const b = new Browser();
    const csrf = csrfOf((await go(b, "GET", "/login")).body);
    await go(b, "POST", "/login/start", { csrf, via: "sms", identifier: "+32 470 00 00 02" });
    const res = await go(b, "POST", "/login/verify", { csrf, code: sms.lastCode(PHONE) });
    expect(res.status).toBe(200);
    expect(
      (await go(new Browser(), "POST", "/login/start", { csrf, via: "sms", identifier: "+44 7700 900123" })).status,
    ).toBe(400);
  });

  async function addPasskey(b: Browser, key: SoftPasskey) {
    const account = await go(b, "GET", "/account");
    const csrf = csrfOf(account.body);
    const headers = { "x-csrf-token": csrf };
    const options = JSON.parse(
      (await go(b, "POST", "/passkeys/register/options", undefined, { json: {}, headers })).body,
    );
    return go(b, "POST", "/passkeys/register/verify", undefined, { json: key.create(options), headers });
  }

  async function passkeyLogin(b: Browser, key: SoftPasskey, over: { origin?: string; tamper?: boolean } = {}) {
    const csrf = csrfOf((await go(b, "GET", "/login")).body);
    const headers = { "x-csrf-token": csrf };
    const options = JSON.parse((await go(b, "POST", "/login/passkey/options", undefined, { json: {}, headers })).body);
    expect(options.userVerification).toBe("required");
    return go(b, "POST", "/login/passkey/verify", undefined, { json: key.get(options, over), headers });
  }

  it("a signed-in person adds a passkey, then signs in with it and no code", async () => {
    const b = new Browser();
    await emailSignIn(b, ADMIN);
    const key = new SoftPasskey({ rpId: RP.id, origin: RP.origin });
    const added = await addPasskey(b, key);
    expect(added.status).toBe(200);
    expect((await go(b, "GET", "/account")).body).toContain("Passkey 1");

    const fresh = new Browser();
    const sent = mailer.sent.length;
    const res = await passkeyLogin(fresh, key);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ redirect: "https://home.example.test/" });
    expect(fresh.cookies.has("identity_auth")).toBe(true);
    expect(mailer.sent.length).toBe(sent);
    expect(store.events()).toEqual(expect.arrayContaining(["passkey.registered", "login.granted"]));
  });

  it("refuses a passkey from another origin, a bad signature, a replayed challenge and no CSRF", async () => {
    const b = new Browser();
    await emailSignIn(b, ADMIN);
    const key = new SoftPasskey({ rpId: RP.id, origin: RP.origin });
    await addPasskey(b, key);
    expect((await passkeyLogin(new Browser(), key, { origin: "https://evil.example" })).status).toBe(400);
    expect((await passkeyLogin(new Browser(), key, { tamper: true })).status).toBe(400);

    const c = new Browser();
    const csrf = csrfOf((await go(c, "GET", "/login")).body);
    const headers = { "x-csrf-token": csrf };
    const options = JSON.parse((await go(c, "POST", "/login/passkey/options", undefined, { json: {}, headers })).body);
    const answer = key.get(options);
    expect((await go(c, "POST", "/login/passkey/verify", undefined, { json: answer })).status).toBe(403);
    expect((await go(c, "POST", "/login/passkey/verify", undefined, { json: answer, headers })).status).toBe(200);
    expect(store.events().filter((e) => e === "passkey.failed").length).toBeGreaterThan(1);
  });

  it("a passkey without user verification can't be added", async () => {
    const b = new Browser();
    await emailSignIn(b, ADMIN);
    const res = await addPasskey(b, new SoftPasskey({ rpId: RP.id, origin: RP.origin, noUserVerification: true }));
    expect(res.status).toBe(400);
  });

  it("a revoked person's passkey proves who they are but grants nothing", async () => {
    await store.addConnection("email", OTHER, "x");
    const b = new Browser();
    await emailSignIn(b, OTHER);
    const key = new SoftPasskey({ rpId: RP.id, origin: RP.origin, alg: -8 });
    await addPasskey(b, key);
    const userId = (await store.connections()).find((c) => c.label === OTHER)!.principalId;
    await store.revoke(userId, "x");
    const res = await passkeyLogin(new Browser(), key);
    expect(JSON.parse(res.body)).toEqual({ redirect: "/login" });
  });

  it("leaves every other path to the provider", async () => {
    for (const [m, p] of [
      ["GET", "/auth"],
      ["POST", "/token"],
      ["GET", "/admin/other"],
    ] as const) {
      expect((await go(new Browser(), m, p)).handled).toBe(false);
    }
  });
});
