/**
 * The headless API (src/headless.ts): trusted apps' servers sign people in by e-mail code, with their
 * own pages. Driven route by route with the in-memory fakes, like sign-in.test.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { headlessClients, loadClients, type HeadlessClient } from "../src/clients.ts";
import { codeEmail, createHeadless, type Headless } from "../src/headless.ts";
import { createLogger } from "../src/log.ts";
import { Browser, CapturingMailer, MemoryChallenges, MemoryLimiter, MemoryStore, request } from "./fakes.ts";

const ISSUER = "https://id.example.test";
const SECRET = "b".repeat(40);
const OTHER_SECRET = "o".repeat(40);
const ADMIN = "admin@example.test";
const CLIENTS = new Map<string, HeadlessClient>([
  ["breinhap", { id: "breinhap", name: "Breinhap", secret: SECRET, selfSignup: true }],
  ["notes", { id: "notes", name: "Notes", secret: OTHER_SECRET, selfSignup: false }],
]);
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

describe("headless sign-in for trusted apps", () => {
  let store: MemoryStore;
  let mailer: CapturingMailer;
  let headless: Headless;
  let logLines: string[];
  let limits: MemoryLimiter;

  beforeEach(async () => {
    store = new MemoryStore();
    mailer = new CapturingMailer();
    logLines = [];
    await store.bootstrapAdmin([{ method: "email", identifier: ADMIN }]);
    headless = createHeadless({
      issuer: ISSUER,
      otpSecret: "s".repeat(40),
      clients: CLIENTS,
      mailer,
      dailyLimit: 100,
      store,
      challenges: new MemoryChallenges(),
      limits: (limits = new MemoryLimiter()),
      log: createLogger((l) => logLines.push(l)),
    });
  });

  const call = (path: string, json: unknown, auth = basic("breinhap", SECRET), method: "GET" | "POST" = "POST") =>
    request((ctx) => headless.handle(ctx), new Browser(), method, path, undefined, {
      json,
      headers: { authorization: auth },
    }).then((r) => ({ ...r, data: r.body ? JSON.parse(String(r.body)) : null }));
  const codeIn = (to: string) => {
    const m = [...mailer.sent].reverse().find((x) => x.to === to.toLowerCase());
    return /\n\n(\d{6})\n\n/.exec(m?.text ?? "")?.[1] ?? "";
  };
  async function signIn(email: string, auth = basic("breinhap", SECRET)) {
    limits.cooldowns.clear(); // the 60 s resend cooldown is tested on its own below
    const start = await call("/headless/v1/email/start", { email, locale: "nl", intent: "register" }, auth);
    expect(start.status).toBe(202);
    return call("/headless/v1/email/verify", { challenge: start.data.challenge, email, code: codeIn(email) }, auth);
  }

  it("a new person registers through a self-signup app with a Dutch e-mail that names the app", async () => {
    const res = await signIn("Nieuw@Example.test");
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ email: "nieuw@example.test", connected: false });
    expect(res.data.sub).toMatch(/^[0-9a-f-]{36}$/);
    const mail = mailer.sent.at(-1)!;
    expect(mail.subject).toMatch(/^Je code voor Breinhap: \d{6}$/);
    expect(mail.text).toContain("Je maakt een account aan voor Breinhap.");
    expect(res.headers["cache-control"]).toBe("no-store");
    // the same person later: the same account, still usable by this app only
    expect((await signIn("nieuw@example.test")).data.sub).toBe(res.data.sub);
    expect((await call("/headless/v1/principal", { sub: res.data.sub })).data).toEqual({
      active: true,
      email: "nieuw@example.test",
    });
    expect((await call("/headless/v1/principal", { sub: res.data.sub }, basic("notes", OTHER_SECRET))).data).toEqual({
      active: false,
    });
  });

  it("an app without self-signup only accepts connected accounts; a revoked one is refused everywhere", async () => {
    const stranger = await signIn("stranger@example.test", basic("notes", OTHER_SECRET));
    expect(stranger.status).toBe(403);
    expect(stranger.data).toEqual({ error: "not_connected" });
    const admin = await signIn(ADMIN, basic("notes", OTHER_SECRET));
    expect(admin.status).toBe(200);
    expect(admin.data.connected).toBe(true);
    await store.revoke(admin.data.sub, admin.data.sub);
    expect((await signIn(ADMIN)).data).toEqual({ error: "revoked" });
    expect((await call("/headless/v1/principal", { sub: admin.data.sub })).data).toEqual({ active: false });
  });

  it("an identifier conflict answers as unavailable (the SDK's generic retry), with no new error for consumers", async () => {
    store.verifiedLogin = async () => ({ kind: "conflict", reason: "identifier_taken" });
    const res = await signIn("conflict@example.test");
    expect(res.status).toBe(503);
    expect(res.data).toEqual({ error: "unavailable" });
  });

  it("every language the platform supports, with English for anything else", () => {
    expect(codeEmail("fr", "Breinhap", "123456", false, "id.example.test").subject).toBe(
      "Votre code pour Breinhap : 123456",
    );
    expect(codeEmail("de", "Breinhap", "123456", true, "id.example.test").text).toContain(
      "Sie erstellen ein Konto für Breinhap.",
    );
    expect(codeEmail("en", "Breinhap", "123456", false, "id.example.test").text).toContain(
      "You are signing in to Breinhap.",
    );
  });

  it("codes are bound to the address and the app, work once, and wrong tries run out", async () => {
    const email = "kim@example.test";
    const start = await call("/headless/v1/email/start", { email, locale: "xx" });
    const code = codeIn(email);
    expect(mailer.sent.at(-1)!.subject).toMatch(/^Your code for Breinhap/);
    // another app can't redeem it, nor another address
    expect(
      (
        await call(
          "/headless/v1/email/verify",
          { challenge: start.data.challenge, email, code },
          basic("notes", OTHER_SECRET),
        )
      ).data.error,
    ).toBe("wrong_code");
    expect(
      (await call("/headless/v1/email/verify", { challenge: start.data.challenge, email: "eve@example.test", code }))
        .data.error,
    ).toBe("wrong_code");
    expect((await call("/headless/v1/email/verify", { challenge: start.data.challenge, email, code })).status).toBe(
      200,
    );
    expect((await call("/headless/v1/email/verify", { challenge: start.data.challenge, email, code })).data.error).toBe(
      "expired",
    );
    // a fresh code, then wrong tries until it is gone
    await new Promise((r) => setTimeout(r, 0));
    const again = await call("/headless/v1/email/start", { email: "lee@example.test" });
    let last;
    for (let i = 0; i < 6; i++)
      last = await call("/headless/v1/email/verify", {
        challenge: again.data.challenge,
        email: "lee@example.test",
        code: "000000",
      });
    expect(last!.data.error).toBe("expired");
    expect(
      (
        await call("/headless/v1/email/verify", {
          challenge: again.data.challenge,
          email: "lee@example.test",
          code: "12",
        })
      ).data.error,
    ).toBe("invalid_code");
  });

  it("start answers the same for a known and an unknown address, and is rate limited", async () => {
    const known = await call("/headless/v1/email/start", { email: ADMIN });
    const unknown = await call("/headless/v1/email/start", { email: "nobody@example.test" });
    expect([known.status, unknown.status]).toEqual([202, 202]);
    expect(Object.keys(known.data).sort()).toEqual(Object.keys(unknown.data).sort());
    const soon = await call("/headless/v1/email/start", { email: ADMIN });
    expect(soon.status).toBe(429);
    expect(soon.data.error).toBe("cooldown");
    expect(soon.headers["retry-after"]).toBe("60");
    expect((await call("/headless/v1/email/start", { email: "not-an-address" })).data.error).toBe("invalid_email");
  });

  it("only an app with its secret gets in; nothing about codes or addresses is logged", async () => {
    for (const auth of [
      "",
      "Bearer x",
      basic("breinhap", "wrong".repeat(10)),
      basic("unknown", SECRET),
      basic("notes", SECRET),
    ]) {
      const res = await call("/headless/v1/email/start", { email: "x@example.test" }, auth);
      expect(res.status).toBe(401);
      expect(res.data).toEqual({ error: "invalid_client" });
    }
    expect((await call("/headless/v1/email/start", {}, basic("breinhap", SECRET), "GET")).status).toBe(405);
    expect((await call("/headless/v1/nope", {})).status).toBe(404);
    expect((await call("/headless/v1/principal", { sub: "../x" })).status).toBe(400);
    expect(await headless.handle({ path: "/login" } as never)).toBe(false);
    await signIn("private@example.test");
    const log = logLines.join("\n") + JSON.stringify(store.auditLog);
    expect(log).not.toContain("private@example.test");
    expect(log).not.toMatch(/\b\d{6}\b(?![0-9a-f-])/);
  });

  it("the client config: a headless client needs a secret and a name", () => {
    const entry = (extra: object) => ({
      client_id: "breinhap",
      primary_domain: "management.breinhap.com",
      redirect_uris: ["https://management.breinhap.com/auth/callback"],
      ...extra,
    });
    const env = { BREINHAP_SECRET: SECRET };
    const file = {
      clients: [entry({ client_secret_env: "BREINHAP_SECRET", name: "Breinhap", headless: { self_signup: true } })],
    };
    expect(headlessClients(file, loadClients(file, env)).get("breinhap")).toEqual({
      id: "breinhap",
      name: "Breinhap",
      secret: SECRET,
      selfSignup: true,
    });
    const noSecret = { clients: [entry({ name: "Breinhap", headless: {} })] };
    expect(() => headlessClients(noSecret, loadClients(noSecret, env))).toThrow(/needs client_secret_env/);
    const noName = { clients: [entry({ client_secret_env: "BREINHAP_SECRET", headless: {} })] };
    expect(() => headlessClients(noName, loadClients(noName, env))).toThrow(/needs a name/);
    const plain = { clients: [entry({ client_secret_env: "BREINHAP_SECRET", name: "Breinhap" })] };
    expect(headlessClients(plain, loadClients(plain, env)).size).toBe(0);
  });
});
