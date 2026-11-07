import { createHash, timingSafeEqual } from "node:crypto";

import type { HeadlessClient } from "./clients.ts";
import { normalizeEmail } from "./email.ts";
import { type HttpContext, readJson } from "./http.ts";
import type { Logger } from "./log.ts";
import type { Mailer } from "./mailer.ts";
import {
  type OtpChallenges,
  type RateLimiter,
  LIMITS,
  OTP_TTL_SECONDS,
  blindHandle,
  generateCode,
  hashCode,
  isCodeShaped,
  newChallengeId,
} from "./otp.ts";
import type { AuditEntry, IdentityStore } from "./store.ts";

/**
 * Headless sign-in for trusted first-party apps (the `headless` clients in the client config).
 *
 * The app shows its own pages, in its own style and language; its server calls these JSON endpoints
 * with its client secret (HTTP Basic), never the browser:
 *
 *   POST /headless/v1/email/start   { email, locale?, intent?, client_ip? }  → 202 { challenge, expires_in }
 *   POST /headless/v1/email/verify  { challenge, email, code, client_ip? }    → 200 { sub, email, connected }
 *   POST /headless/v1/principal     { sub }                                   → 200 { active, email }
 *
 * The account stays here: one principal per person across every ASafariM app, the same codes, limits
 * and audit trail as the web sign-in. Identity sends the code (the app never sees it), naming the app,
 * in the person's language (nl, fr, en, de).
 *
 * Access. A principal with an active connection may use any headless app. A `self_signup` app (Breinhap)
 * also accepts a principal that has no connection yet, for that app only: the app runs its own approval
 * (Breinhap's administrator approves the role). Other apps still refuse that principal, and the OIDC
 * provider still issues it no tokens. A revoked connection is refused everywhere.
 *
 * `start` answers the same for a known and an unknown address (no probing). A challenge is bound to the
 * address and to the app: a code sent for one app can't be redeemed by another.
 */

export const LOCALES = ["nl", "fr", "en", "de"] as const;
export type Locale = (typeof LOCALES)[number];

export interface HeadlessDeps {
  issuer: string;
  otpSecret: string;
  clients: ReadonlyMap<string, HeadlessClient>;
  mailer: Mailer;
  dailyLimit: number;
  store: Pick<IdentityStore, "verifiedLogin" | "principal" | "audit">;
  challenges: OtpChallenges;
  limits: RateLimiter;
  log: Logger;
}

export interface Headless {
  /** Handles /headless/v1/…; false for any other path. */
  handle(ctx: HttpContext): Promise<boolean>;
}

const minutes = Math.round(OTP_TTL_SECONDS / 60);

/** The code e-mail, per language. `intent` only changes the first line. */
const MESSAGES: Record<
  Locale,
  (o: { app: string; code: string; register: boolean; host: string }) => { subject: string; text: string }
> = {
  nl: ({ app, code, register, host }) => ({
    subject: `Je code voor ${app}: ${code}`,
    text: `${register ? `Je maakt een account aan voor ${app}.` : `Je meldt je aan bij ${app}.`} Je code is:\n\n${code}\n\nDe code werkt ${minutes} minuten en één keer. Geef hem aan niemand: ${app} en ASafariM vragen er nooit om.\n\nWas jij dit niet? Dan kun je deze e-mail negeren.\n\nVerzonden door ASafariM (${host}), het aanmeldplatform achter ${app}.\n`,
  }),
  fr: ({ app, code, register, host }) => ({
    subject: `Votre code pour ${app} : ${code}`,
    text: `${register ? `Vous créez un compte pour ${app}.` : `Vous vous connectez à ${app}.`} Votre code est :\n\n${code}\n\nIl est valable ${minutes} minutes et une seule fois. Ne le communiquez à personne : ${app} et ASafariM ne vous le demanderont jamais.\n\nCe n'était pas vous ? Vous pouvez ignorer cet e-mail.\n\nEnvoyé par ASafariM (${host}), la plateforme de connexion de ${app}.\n`,
  }),
  en: ({ app, code, register, host }) => ({
    subject: `Your code for ${app}: ${code}`,
    text: `${register ? `You are creating an account for ${app}.` : `You are signing in to ${app}.`} Your code is:\n\n${code}\n\nIt works for ${minutes} minutes and only once. Never share it: ${app} and ASafariM will never ask you for it.\n\nWasn't you? You can ignore this email.\n\nSent by ASafariM (${host}), the sign-in platform behind ${app}.\n`,
  }),
  de: ({ app, code, register, host }) => ({
    subject: `Ihr Code für ${app}: ${code}`,
    text: `${register ? `Sie erstellen ein Konto für ${app}.` : `Sie melden sich bei ${app} an.`} Ihr Code lautet:\n\n${code}\n\nEr gilt ${minutes} Minuten und nur einmal. Geben Sie ihn niemandem weiter: ${app} und ASafariM fragen nie danach.\n\nWaren Sie das nicht? Dann können Sie diese E-Mail ignorieren.\n\nGesendet von ASafariM (${host}), der Anmeldeplattform hinter ${app}.\n`,
  }),
};

export function codeEmail(locale: Locale, app: string, code: string, register: boolean, host: string) {
  return MESSAGES[locale]({ app, code, register, host });
}

const CHALLENGE = /^[A-Za-z0-9_-]{16,64}$/;
const SUB = /^[A-Za-z0-9-]{1,64}$/;

const sameSecret = (a: string, b: string) => {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
};

export function createHeadless(d: HeadlessDeps): Headless {
  const host = new URL(d.issuer).host;
  const handleOf = (kind: string, value: string) => blindHandle(d.otpSecret, kind, value);

  async function audit(entry: AuditEntry) {
    try {
      await d.store.audit(entry);
    } catch (err) {
      d.log.error("audit.write_failed", { event: entry.event, errorCode: (err as Error).name });
    }
  }

  const json = (ctx: HttpContext, status: number, body: unknown) => {
    ctx.status = status;
    ctx.type = "application/json";
    ctx.set("Cache-Control", "no-store");
    ctx.body = JSON.stringify(body);
  };

  /** The calling app, from HTTP Basic; null for anything else. */
  function authenticate(ctx: HttpContext): HeadlessClient | null {
    const match = /^Basic ([A-Za-z0-9+/=]{4,400})$/.exec(ctx.get("authorization"));
    if (!match) return null;
    const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 1) return null;
    const client = d.clients.get(decodeURIComponent(decoded.slice(0, colon)));
    const secret = decodeURIComponent(decoded.slice(colon + 1));
    // compare even for an unknown id, so timing says nothing about which ids exist
    const ok = sameSecret(secret, client?.secret ?? "\0unknown");
    return client && ok ? client : null;
  }

  const localeOf = (value: unknown): Locale =>
    typeof value === "string" && (LOCALES as readonly string[]).includes(value) ? (value as Locale) : "en";
  /** The end user's address as the app saw it: only ever hashed, for per-person limits. */
  const ipOf = (value: unknown) =>
    typeof value === "string" && value.length <= 64 && /^[0-9a-fA-F:.]+$/.test(value) ? value : null;
  const challengeKey = (client: HeadlessClient, email: string) => `email:${email}#${client.id}`;

  async function start(ctx: HttpContext, client: HeadlessClient, body: Record<string, unknown>) {
    const email = typeof body.email === "string" ? normalizeEmail(body.email.slice(0, 256)) : null;
    if (!email) return json(ctx, 400, { error: "invalid_email" });
    const locale = localeOf(body.locale);
    const register = body.intent === "register";
    const subject = handleOf("email", email);
    const ip = ipOf(body.client_ip);
    const refuse = async (reason: string, retryAfter: number) => {
      await audit({
        event: "otp.send_refused",
        method: "email",
        subjectHandle: subject,
        detail: { reason, clientId: client.id, via: "headless" },
      });
      ctx.set("Retry-After", String(retryAfter));
      return json(ctx, 429, { error: reason === "cooldown" ? "cooldown" : "rate_limited", retry_after: retryAfter });
    };
    if (!(await d.limits.cooldown("send-email", subject, LIMITS.resendCooldownSeconds)))
      return refuse("cooldown", LIMITS.resendCooldownSeconds);
    const checks: [string, Promise<{ allowed: boolean; retryAfter: number }>][] = [
      ["subject", d.limits.hit("send-email", subject, LIMITS.sendPerPhone)],
      ["subject_daily", d.limits.hit("send-email-day", subject, LIMITS.sendPerPhoneDaily)],
      ...(ip
        ? [
            ["ip", d.limits.hit("send-ip", handleOf("ip", ip), LIMITS.sendPerIp)] as [
              string,
              Promise<{ allowed: boolean; retryAfter: number }>,
            ],
          ]
        : []),
    ];
    for (const [reason, check] of checks) {
      const result = await check;
      if (!result.allowed) return refuse(reason, result.retryAfter);
    }
    const budget = await d.limits.hit("send-global-email", "all", { max: d.dailyLimit, windowSeconds: 24 * 3600 });
    if (!budget.allowed) {
      d.log.warn("code.daily_budget_reached", { reason: "email" });
      return refuse("global_budget", budget.retryAfter);
    }
    const challenge = newChallengeId();
    const code = generateCode();
    await d.challenges.create(challenge, hashCode(d.otpSecret, challenge, challengeKey(client, email), code));
    try {
      await d.mailer.send({ to: email, ...codeEmail(locale, client.name, code, register, host) });
    } catch {
      d.log.error("code.send_failed", { reason: "email:headless" });
      await audit({
        event: "otp.send_failed",
        method: "email",
        subjectHandle: subject,
        detail: { clientId: client.id, via: "headless" },
      });
      return json(ctx, 503, { error: "send_failed" });
    }
    await audit({
      event: "otp.sent",
      method: "email",
      subjectHandle: subject,
      detail: { clientId: client.id, via: "headless" },
    });
    json(ctx, 202, { challenge, expires_in: OTP_TTL_SECONDS });
  }

  /** May this principal use this app? Active connection anywhere; a self-signup app also a new one. */
  function allowed(client: HeadlessClient, connection: "active" | "revoked" | "none") {
    if (connection === "active") return true;
    return client.selfSignup && connection === "none";
  }

  async function verify(ctx: HttpContext, client: HeadlessClient, body: Record<string, unknown>) {
    const email = typeof body.email === "string" ? normalizeEmail(body.email.slice(0, 256)) : null;
    const challenge = typeof body.challenge === "string" && CHALLENGE.test(body.challenge) ? body.challenge : null;
    const code = typeof body.code === "string" ? body.code.replace(/\s/g, "") : "";
    if (!email || !challenge) return json(ctx, 400, { error: "invalid_request" });
    if (!isCodeShaped(code)) return json(ctx, 400, { error: "invalid_code" });
    const subject = handleOf("email", email);
    const ip = ipOf(body.client_ip);
    for (const [reason, check] of [
      ["subject", d.limits.hit("verify-email", subject, LIMITS.verifyPerPhone)],
      ...(ip ? [["ip", d.limits.hit("verify-ip", handleOf("ip", ip), LIMITS.verifyPerIp)]] : []),
    ] as [string, Promise<{ allowed: boolean; retryAfter: number }>][]) {
      const result = await check;
      if (!result.allowed) {
        await audit({
          event: "otp.verify_refused",
          method: "email",
          subjectHandle: subject,
          detail: { reason, clientId: client.id, via: "headless" },
        });
        ctx.set("Retry-After", String(result.retryAfter));
        return json(ctx, 429, { error: "rate_limited", retry_after: result.retryAfter });
      }
    }
    const result = await d.challenges.verify(
      challenge,
      hashCode(d.otpSecret, challenge, challengeKey(client, email), code),
    );
    if (result !== "ok") {
      await audit({
        event: "otp.verify_failed",
        method: "email",
        subjectHandle: subject,
        detail: { reason: result, clientId: client.id, via: "headless" },
      });
      // "wrong": try again; "exhausted"/"missing": ask for a new code
      return json(ctx, 400, { error: result === "wrong" ? "wrong_code" : "expired" });
    }
    const verified = await d.store.verifiedLogin("email", email);
    if (verified.kind !== "ok") {
      // A conflict on the identifier: the SDK reads any 5xx as "unavailable" and the app shows its generic
      // retry, so this adds no new answer for consumers and reveals nothing.
      await audit({
        event: "login.not_authorized",
        method: "email",
        subjectHandle: subject,
        detail: { clientId: client.id, via: "headless", reason: verified.reason },
      });
      return json(ctx, 503, { error: "unavailable" });
    }
    const sub = verified.principalId;
    const principal = await d.store.principal(sub);
    const connection = principal?.connection ?? "none";
    await audit({
      event: "otp.verified",
      method: "email",
      principalId: sub,
      subjectHandle: subject,
      detail: { clientId: client.id, via: "headless" },
    });
    if (!allowed(client, connection)) {
      await audit({
        event: "login.not_authorized",
        method: "email",
        principalId: sub,
        detail: { clientId: client.id, via: "headless", reason: connection },
      });
      return json(ctx, 403, { error: connection === "revoked" ? "revoked" : "not_connected" });
    }
    await audit({
      event: "login.granted",
      method: "email",
      principalId: sub,
      detail: { clientId: client.id, via: "headless" },
    });
    json(ctx, 200, { sub, email, connected: connection === "active" });
  }

  async function principal(ctx: HttpContext, client: HeadlessClient, body: Record<string, unknown>) {
    const sub = typeof body.sub === "string" && SUB.test(body.sub) ? body.sub : null;
    if (!sub) return json(ctx, 400, { error: "invalid_request" });
    const p = await d.store.principal(sub);
    const active = Boolean(p) && allowed(client, p!.connection);
    json(ctx, 200, { active, ...(active && p!.label?.includes("@") ? { email: p!.label } : {}) });
  }

  return {
    async handle(ctx) {
      if (!ctx.path.startsWith("/headless/v1/")) return false;
      if (ctx.method !== "POST") {
        ctx.set("Allow", "POST");
        json(ctx, 405, { error: "method_not_allowed" });
        return true;
      }
      const client = authenticate(ctx);
      if (!client) {
        ctx.set("WWW-Authenticate", 'Basic realm="headless"');
        json(ctx, 401, { error: "invalid_client" });
        return true;
      }
      const body = await readJson(ctx);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        json(ctx, 400, { error: "invalid_request" });
        return true;
      }
      const fields = body as Record<string, unknown>;
      switch (ctx.path) {
        case "/headless/v1/email/start":
          await start(ctx, client, fields);
          return true;
        case "/headless/v1/email/verify":
          await verify(ctx, client, fields);
          return true;
        case "/headless/v1/principal":
          await principal(ctx, client, fields);
          return true;
        default:
          json(ctx, 404, { error: "not_found" });
          return true;
      }
    },
  };
}
