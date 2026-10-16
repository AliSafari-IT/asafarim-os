/**
 * id.asafarim.site's own sign-in (IDENTITY_LOGIN_METHOD=local) and the connections admin.
 *
 *   QR code / link → /connect → /login → a passkey, or an email (or SMS) code
 *     → connected?     yes: continue (the OIDC sign-in in progress, or the home URL)
 *                      no:  "Request connection" → an admin approves → sign in again
 *
 * Authentication (a passkey, or a code that proves the person holds the address or number) and
 * authorization (an active connection in the database) are separate steps; neither the QR code,
 * the URL nor an address alone grants anything, and authorization is read from the database on
 * every use. Until a code is proved, every answer is the same whether or not the address is known.
 * A signed-in person adds passkeys on /account.
 */
import {
  type AuthSession,
  type AuthSessions,
  type Ephemeral,
  type LoginFlow,
  type LoginFlows,
  type LoginTarget,
  AUTH_SESSION_TTL_SECONDS,
  LOGIN_FLOW_TTL_SECONDS,
  newToken,
  sameToken,
} from "./auth-session.ts";
import { maskEmail, normalizeEmail } from "./email.ts";
import { type HttpContext, clientIp, queryValue, readForm, readJson, sendHtml } from "./http.ts";
import type { Logger } from "./log.ts";
import {
  LIMITS,
  OTP_TTL_SECONDS,
  type OtpChallenges,
  type RateLimiter,
  blindHandle,
  generateCode,
  hashCode,
  isCodeShaped,
  newChallengeId,
} from "./otp.ts";
import { PASSKEY_JS } from "./passkey-client.ts";
import { maskPhone, normalizePhone, prefixAllowed } from "./phone.ts";
import { type SmsSender, SmsError, codeMessage } from "./sms.ts";
import { type Mailer, MailError } from "./smtp.ts";
import {
  PAGE_CSP,
  PASSKEY_PAGE_CSP,
  accountPage,
  adminPage,
  codePage,
  continueToPage,
  loginPage,
  messagePage,
  notConnectedPage,
} from "./sign-in-pages.ts";
import { CONTINUE_PAGE_CSP } from "./pages.ts";
import type { AuditEntry, IdentityMethod, IdentityStore, Principal } from "./store.ts";
import {
  type RelyingParty,
  WebAuthnError,
  assertionCredentialId,
  authenticationOptions,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from "./webauthn.ts";

export const AUTH_COOKIE = "identity_auth";
export const FLOW_COOKIE = "identity_login";
const FLOW_COOKIE_PATH = "/login";

export interface SignInDeps {
  issuer: string;
  /** Where a sign-in that didn't come from an app continues (the QR code's destination). */
  homeUrl: string;
  /** HMAC key for codes, rate-limit keys and audit handles (IDENTITY_OTP_SECRET). */
  otpSecret: string;
  /** Email codes, when on: the mailer and the most emails per 24 h, all addresses together. */
  email?: { mailer: Mailer; dailyLimit: number };
  /** SMS codes, when on. */
  sms?: { sender: SmsSender; allowedPrefixes: readonly string[]; dailyLimit: number };
  /** Passkeys, when on: the relying party (the issuer's host and origin). */
  passkeys?: { rp: RelyingParty };
  ephemeral: Ephemeral;
  store: IdentityStore;
  challenges: OtpChallenges;
  limits: RateLimiter;
  sessions: AuthSessions;
  flows: LoginFlows;
  /** Ends the provider (OIDC) sessions of an account and revokes their grants; returns how many. */
  endProviderSessions: (principalId: string) => Promise<number>;
  log: Logger;
}

/** A browser whose auth session belongs to a principal with an active connection. */
export interface AuthorizedPrincipal {
  principalId: string;
  /** When the code was proved (epoch seconds). */
  authTime: number;
}

export interface SignIn {
  /** Handles /connect, /login*, /logout, /account*, /passkeys*, /static/passkey.js and /admin*; false otherwise. */
  handle(ctx: HttpContext): Promise<boolean>;
  /** The authorized principal of this browser, if any (read fresh from the database). */
  authorizedPrincipal(ctx: HttpContext): Promise<AuthorizedPrincipal | null>;
  /** Records that an OIDC sign-in was completed from an existing auth session. */
  auditInteractionLogin(ctx: HttpContext, principalId: string, clientId: string): Promise<void>;
  loginUrl(uid: string, fresh: boolean): string;
}

const UID = /^[\w-]{1,64}$/;
const REQUEST_ACTION = /^\/admin\/requests\/([0-9a-f-]{36})\/(approve|reject)$/;
const REVOKE_ACTION = /^\/admin\/connections\/([0-9a-f-]{36})\/revoke$/;
const NOTICES: Record<string, string> = {
  approved: "Request approved: they're now connected.",
  rejected: "Request rejected.",
  revoked: "Connection revoked. Their sign-in sessions have ended.",
  added: "Connected.",
  stale: "That request or connection had already changed. Nothing was done.",
  self: "You can't revoke your own connection.",
};

type Via = "email" | "sms";

interface Channel {
  method: IdentityMethod;
  normalize(input: string): string | null;
  invalid: string;
  /** A refusal that isn't secret (a country not served), or null. */
  refuse(identifier: string): string | null;
  mask(identifier: string): string;
  send(identifier: string, code: string): Promise<void>;
  dailyLimit: number;
  /** "the email" / "the SMS", in error texts. */
  noun: string;
}

export function createSignIn(d: SignInDeps): SignIn {
  const issuerHost = new URL(d.issuer).host;
  const minutes = Math.round(OTP_TTL_SECONDS / 60);
  const ipHandle = (ctx: HttpContext) => blindHandle(d.otpSecret, "ip", clientIp(ctx));
  const subjectHandle = (via: Via, identifier: string) => blindHandle(d.otpSecret, via, identifier);

  const channels: Partial<Record<Via, Channel>> = {};
  if (d.email) {
    const { mailer, dailyLimit } = d.email;
    channels.email = {
      method: "email",
      normalize: normalizeEmail,
      invalid: "Enter a valid email address.",
      refuse: () => null,
      mask: maskEmail,
      send: (to, code) =>
        mailer.send({
          to,
          subject: `Your ASafariM sign-in code: ${code}`,
          text: `Your ASafariM sign-in code is ${code}.\n\nIt expires in ${minutes} minutes and works once. Never share it with anyone: ASafariM will never ask you for it.\n\nIf you didn't try to sign in at ${issuerHost}, you can ignore this email.\n`,
        }),
      dailyLimit,
      noun: "the email",
    };
  }
  if (d.sms) {
    const { sender, allowedPrefixes, dailyLimit } = d.sms;
    channels.sms = {
      method: "phone",
      normalize: normalizePhone,
      invalid: "Enter your full mobile number with its country code, for example +32 470 12 34 56.",
      refuse: (phone) =>
        prefixAllowed(phone, allowedPrefixes) ? null : "Sign-in by SMS isn't available for numbers in this country.",
      mask: maskPhone,
      send: (to, code) => sender.send(to, codeMessage(code, issuerHost, minutes)),
      dailyLimit,
      noun: "the SMS",
    };
  }
  const login = (csrf: string, extra: { error?: string; value?: string } = {}) =>
    loginPage({
      csrf,
      email: Boolean(channels.email),
      sms: Boolean(channels.sms),
      passkey: Boolean(d.passkeys),
      ...extra,
    });

  /** Auditing must never break a sign-in: a failed write is logged and the request goes on. */
  async function audit(entry: AuditEntry) {
    try {
      await d.store.audit(entry);
    } catch (err) {
      d.log.error("audit.write_failed", { event: entry.event, errorCode: (err as Error).name });
    }
  }

  function render(ctx: HttpContext, status: number, html: string, csp = PAGE_CSP) {
    sendHtml(ctx, status, html);
    ctx.set("Content-Security-Policy", csp);
    ctx.set("Referrer-Policy", "no-referrer");
    ctx.set("X-Content-Type-Options", "nosniff");
    if (ctx.secure) ctx.set("Strict-Transport-Security", "max-age=31536000");
  }

  function seeOther(ctx: HttpContext, url: string) {
    ctx.set("Cache-Control", "no-store");
    ctx.redirect(url);
    ctx.status = 303;
  }

  function setCookie(ctx: HttpContext, name: string, value: string | null, path: string, maxAgeSeconds: number) {
    ctx.cookies.set(name, value, {
      path,
      httpOnly: true,
      sameSite: "lax",
      secure: ctx.secure,
      ...(value ? { maxAge: maxAgeSeconds * 1000 } : {}),
      signed: false,
      overwrite: true,
    });
  }

  async function currentSession(ctx: HttpContext): Promise<{ token: string; session: AuthSession } | null> {
    const token = ctx.cookies.get(AUTH_COOKIE, { signed: false });
    if (!token) return null;
    const session = await d.sessions.get(token);
    return session ? { token, session } : null;
  }

  async function currentFlow(ctx: HttpContext): Promise<{ token: string; flow: LoginFlow } | null> {
    const token = ctx.cookies.get(FLOW_COOKIE, { signed: false });
    if (!token) return null;
    const flow = await d.flows.get(token);
    return flow ? { token, flow } : null;
  }

  function targetHref(target: LoginTarget): string {
    if (target.kind === "interaction") return `/interaction/${target.uid}`;
    if (target.kind === "admin") return "/admin";
    return d.homeUrl;
  }

  function expired(ctx: HttpContext) {
    render(
      ctx,
      400,
      messagePage({
        title: "This page has expired",
        message: "For your security, sign-in pages are only valid for a short time.",
        link: { href: "/login", label: "Start again" },
      }),
    );
  }

  // ---- GET /login -----------------------------------------------------------------------------

  async function startLogin(ctx: HttpContext) {
    const uid = queryValue(ctx, "uid");
    const next = queryValue(ctx, "next");
    const target: LoginTarget =
      uid && UID.test(uid) ? { kind: "interaction", uid } : next === "admin" ? { kind: "admin" } : { kind: "home" };
    // `fresh=1`: the app asked for a new sign-in (prompt=login, max_age), so an existing session doesn't count.
    const fresh = queryValue(ctx, "fresh") === "1";

    const current = fresh ? null : await currentSession(ctx);
    if (current) {
      const principal = await d.store.principal(current.session.principalId);
      if (principal?.connection === "active") return seeOther(ctx, targetHref(target));
      if (principal) {
        const pending = await d.store.hasPendingRequest(principal.id);
        return render(ctx, 200, notConnectedPage({ csrf: current.session.csrf, pending }));
      }
    }
    // Reuse this browser's flow if it has one (a reload doesn't store a new one); otherwise start one,
    // within a per-IP budget so the page can't be used to fill Redis.
    const existing = await currentFlow(ctx);
    if (existing) {
      const flow: LoginFlow = { csrf: existing.flow.csrf, target };
      await d.flows.update(existing.token, flow);
      return render(ctx, 200, login(flow.csrf), PASSKEY_PAGE_CSP);
    }
    const budget = await d.limits.hit("flow-ip", ipHandle(ctx), LIMITS.flowsPerIp);
    if (!budget.allowed) {
      ctx.set("Retry-After", String(budget.retryAfter));
      return render(
        ctx,
        429,
        messagePage({ title: "Too many attempts", message: "Please wait a while before trying to sign in again." }),
      );
    }
    const flow: LoginFlow = { csrf: newToken(), target };
    const token = await d.flows.create(flow);
    setCookie(ctx, FLOW_COOKIE, token, FLOW_COOKIE_PATH, LOGIN_FLOW_TTL_SECONDS);
    render(ctx, 200, login(flow.csrf), PASSKEY_PAGE_CSP);
  }

  // ---- sending a code ---------------------------------------------------------------------------

  async function refuseSend(
    ctx: HttpContext,
    flow: LoginFlow,
    via: Via,
    identifier: string,
    reason: string,
    retryAfter: number,
  ) {
    await audit({
      event: "otp.send_refused",
      method: via,
      subjectHandle: subjectHandle(via, identifier),
      ipHandle: ipHandle(ctx),
      detail: { reason },
    });
    const mins = Math.max(1, Math.ceil(retryAfter / 60));
    const message =
      reason === "cooldown"
        ? "A code was just sent. Wait a minute before asking for another one."
        : `Too many codes were requested. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`;
    ctx.set("Retry-After", String(retryAfter));
    if (flow.identifier === identifier && flow.challengeId) {
      const masked = channels[via]!.mask(identifier);
      return render(ctx, 429, codePage({ csrf: flow.csrf, masked, via, error: message }));
    }
    return render(ctx, 429, login(flow.csrf, { error: message, value: identifier }), PASSKEY_PAGE_CSP);
  }

  async function sendCode(ctx: HttpContext, flowToken: string, flow: LoginFlow, via: Via, identifier: string) {
    const channel = channels[via]!;
    const ip = ipHandle(ctx);
    const subject = subjectHandle(via, identifier);
    // The cooldown first: a click on "send again" too soon doesn't use up the quota.
    if (!(await d.limits.cooldown(`send-${via}`, subject, LIMITS.resendCooldownSeconds))) {
      return refuseSend(ctx, flow, via, identifier, "cooldown", LIMITS.resendCooldownSeconds);
    }
    const checks: [string, Promise<{ allowed: boolean; retryAfter: number }>][] = [
      ["ip", d.limits.hit("send-ip", ip, LIMITS.sendPerIp)],
      ["subject", d.limits.hit(`send-${via}`, subject, LIMITS.sendPerPhone)],
      ["subject_daily", d.limits.hit(`send-${via}-day`, subject, LIMITS.sendPerPhoneDaily)],
    ];
    for (const [reason, check] of checks) {
      const result = await check;
      if (!result.allowed) return refuseSend(ctx, flow, via, identifier, reason, result.retryAfter);
    }
    const budget = await d.limits.hit(`send-global-${via}`, "all", {
      max: channel.dailyLimit,
      windowSeconds: 24 * 3600,
    });
    if (!budget.allowed) {
      d.log.warn("code.daily_budget_reached", { reason: via });
      return refuseSend(ctx, flow, via, identifier, "global_budget", budget.retryAfter);
    }

    const challengeId = newChallengeId();
    const code = generateCode();
    await d.challenges.create(challengeId, hashCode(d.otpSecret, challengeId, `${via}:${identifier}`, code));
    try {
      await channel.send(identifier, code);
    } catch (err) {
      const reason = err instanceof SmsError || err instanceof MailError ? err.reason : "error";
      d.log.error("code.send_failed", { reason: `${via}:${reason}` });
      await audit({ event: "otp.send_failed", method: via, subjectHandle: subject, ipHandle: ip, detail: { reason } });
      const error = "We couldn't send a code right now. Please try again in a few minutes.";
      return render(ctx, 503, login(flow.csrf, { error, value: identifier }), PASSKEY_PAGE_CSP);
    }
    await d.flows.update(flowToken, { csrf: flow.csrf, target: flow.target, via, identifier, challengeId });
    await audit({ event: "otp.sent", method: via, subjectHandle: subject, ipHandle: ip });
    d.log.info("code.sent", { reason: via });
    seeOther(ctx, "/login/code");
  }

  async function postStart(ctx: HttpContext) {
    const form = await readForm(ctx);
    const current = await currentFlow(ctx);
    if (!form || !current || !sameToken(form.get("csrf"), current.flow.csrf)) return expired(ctx);
    const { token, flow } = current;
    const viaRaw = form.get("via");
    const via: Via | null = viaRaw === "email" || viaRaw === "sms" ? viaRaw : null;
    const channel = via ? channels[via] : undefined;
    if (!via || !channel) return expired(ctx);
    const typed = (form.get("identifier") ?? "").slice(0, 256);
    const identifier = channel.normalize(typed);
    if (!identifier) {
      return render(ctx, 400, login(flow.csrf, { error: channel.invalid, value: typed }), PASSKEY_PAGE_CSP);
    }
    const refused = channel.refuse(identifier);
    if (refused) {
      await audit({
        event: "otp.send_refused",
        method: via,
        subjectHandle: subjectHandle(via, identifier),
        ipHandle: ipHandle(ctx),
        detail: { reason: "not_served" },
      });
      return render(ctx, 400, login(flow.csrf, { error: refused, value: typed }), PASSKEY_PAGE_CSP);
    }
    // A new address starts a new challenge: the previous one is never redeemable from this flow.
    return sendCode(ctx, token, { csrf: flow.csrf, target: flow.target }, via, identifier);
  }

  async function postResend(ctx: HttpContext) {
    const form = await readForm(ctx);
    const current = await currentFlow(ctx);
    if (!form || !current || !sameToken(form.get("csrf"), current.flow.csrf)) return expired(ctx);
    const { via, identifier } = current.flow;
    if (!via || !identifier || !channels[via]) return seeOther(ctx, "/login/restart");
    return sendCode(ctx, current.token, current.flow, via, identifier);
  }

  async function showCode(ctx: HttpContext) {
    const current = await currentFlow(ctx);
    const via = current?.flow.via;
    const identifier = current?.flow.identifier;
    if (!current || !via || !identifier || !channels[via]) return seeOther(ctx, "/login");
    render(ctx, 200, codePage({ csrf: current.flow.csrf, masked: channels[via]!.mask(identifier), via }));
  }

  async function restart(ctx: HttpContext) {
    const current = await currentFlow(ctx);
    if (!current) return seeOther(ctx, "/login");
    const flow: LoginFlow = { csrf: current.flow.csrf, target: current.flow.target };
    await d.flows.update(current.token, flow);
    render(ctx, 200, login(flow.csrf), PASSKEY_PAGE_CSP);
  }

  // ---- after a proof (a code or a passkey) ------------------------------------------------------

  /**
   * The person proved who they are. Starts a fresh session (any previous one in this browser is
   * replaced: no fixation), then decides authorization on the server. Returns where to go next.
   */
  async function signedIn(
    ctx: HttpContext,
    flowToken: string,
    flow: LoginFlow,
    principalId: string,
    method: "email" | "sms" | "passkey",
  ): Promise<{ authorized: boolean; next: string }> {
    await d.flows.destroy(flowToken);
    setCookie(ctx, FLOW_COOKIE, null, FLOW_COOKIE_PATH, 0);
    const previous = await currentSession(ctx);
    if (previous) await d.sessions.destroy(previous.token);
    const created = await d.sessions.create(principalId);
    setCookie(ctx, AUTH_COOKIE, created.token, "/", AUTH_SESSION_TTL_SECONDS);

    const ip = ipHandle(ctx);
    const principal = await d.store.principal(principalId);
    if (principal?.connection !== "active") {
      await audit({ event: "login.not_authorized", method, principalId, ipHandle: ip });
      d.log.info("login.not_authorized", { reason: principal?.connection ?? "unknown" });
      return { authorized: false, next: "/login" };
    }
    await audit({ event: "login.granted", method, principalId, ipHandle: ip, detail: { target: flow.target.kind } });
    d.log.info("login.granted", { reason: `${method}:${flow.target.kind}` });
    return { authorized: true, next: targetHref(flow.target) };
  }

  // ---- verifying a code -------------------------------------------------------------------------

  async function postVerify(ctx: HttpContext) {
    const form = await readForm(ctx);
    const current = await currentFlow(ctx);
    if (!form || !current || !sameToken(form.get("csrf"), current.flow.csrf)) return expired(ctx);
    const { token, flow } = current;
    const { via, identifier } = flow;
    const channel = via ? channels[via] : undefined;
    if (!via || !identifier || !channel) return seeOther(ctx, "/login");
    const masked = channel.mask(identifier);
    const ip = ipHandle(ctx);
    const subject = subjectHandle(via, identifier);
    const page = (status: number, error: string) =>
      render(ctx, status, codePage({ csrf: flow.csrf, masked, via, error }));

    for (const [reason, check] of [
      ["ip", d.limits.hit("verify-ip", ip, LIMITS.verifyPerIp)],
      ["subject", d.limits.hit(`verify-${via}`, subject, LIMITS.verifyPerPhone)],
    ] as const) {
      const result = await check;
      if (!result.allowed) {
        await audit({
          event: "otp.verify_refused",
          method: via,
          subjectHandle: subject,
          ipHandle: ip,
          detail: { reason },
        });
        ctx.set("Retry-After", String(result.retryAfter));
        return page(429, "Too many tries. Wait a while, then ask for a new code.");
      }
    }

    const code = (form.get("code") ?? "").replace(/\s/g, "");
    if (!isCodeShaped(code)) return page(400, `Enter the 6-digit code from ${channel.noun}.`);
    if (!flow.challengeId) return page(400, "This code is no longer valid. Send a new code.");
    const result = await d.challenges.verify(
      flow.challengeId,
      hashCode(d.otpSecret, flow.challengeId, `${via}:${identifier}`, code),
    );
    if (result !== "ok") {
      await audit({
        event: "otp.verify_failed",
        method: via,
        subjectHandle: subject,
        ipHandle: ip,
        detail: { reason: result },
      });
      if (result === "wrong") return page(400, `That code isn't right. Check ${channel.noun} and try again.`);
      await d.flows.update(token, { csrf: flow.csrf, target: flow.target, via, identifier });
      return page(400, "This code has expired or had too many wrong tries. Send a new code.");
    }

    const principalId = await d.store.verifiedLogin(channel.method, identifier);
    await audit({ event: "otp.verified", method: via, principalId, subjectHandle: subject, ipHandle: ip });
    const outcome = await signedIn(ctx, token, flow, principalId, via);
    if (!outcome.authorized) return seeOther(ctx, outcome.next);
    render(ctx, 200, continueToPage(outcome.next), CONTINUE_PAGE_CSP);
  }

  // ---- passkeys ---------------------------------------------------------------------------------

  function json(ctx: HttpContext, status: number, body: unknown) {
    ctx.status = status;
    ctx.type = "application/json";
    ctx.set("Cache-Control", "no-store");
    ctx.set("X-Content-Type-Options", "nosniff");
    ctx.body = JSON.stringify(body);
  }

  const EXPIRED = { error: "This page has expired. Reload it." };

  /** JSON calls from our own script: the page's CSRF token in a header, and a JSON body. */
  async function jsonCall(ctx: HttpContext, csrf: string): Promise<unknown> {
    const header = ctx.get("x-csrf-token");
    if (!sameToken(header || undefined, csrf)) return undefined;
    return (await readJson(ctx)) ?? undefined;
  }

  async function passkeyLoginOptions(ctx: HttpContext) {
    const current = await currentFlow(ctx);
    if (!current || !d.passkeys) return json(ctx, 400, EXPIRED);
    if ((await jsonCall(ctx, current.flow.csrf)) === undefined) return json(ctx, 403, EXPIRED);
    const challenge = newToken();
    await d.ephemeral.put(`passkey-login:${current.token}`, challenge, 300);
    json(ctx, 200, authenticationOptions(d.passkeys.rp, challenge));
  }

  async function passkeyLoginVerify(ctx: HttpContext) {
    const current = await currentFlow(ctx);
    if (!current || !d.passkeys) return json(ctx, 400, EXPIRED);
    const body = await jsonCall(ctx, current.flow.csrf);
    if (body === undefined) return json(ctx, 403, EXPIRED);
    const ip = ipHandle(ctx);
    const limit = await d.limits.hit("verify-ip", ip, LIMITS.verifyPerIp);
    if (!limit.allowed) return json(ctx, 429, { error: "Too many tries. Wait a while and try again." });
    const challenge = await d.ephemeral.take(`passkey-login:${current.token}`);
    const refuse = async (code: string) => {
      await audit({ event: "passkey.failed", method: "passkey", ipHandle: ip, detail: { reason: code } });
      json(ctx, 400, { error: "That passkey couldn't be used here. Try again, or use a code." });
    };
    if (!challenge) return refuse("no_challenge");
    let credentialId: string;
    try {
      credentialId = assertionCredentialId(body);
    } catch (err) {
      return refuse(err instanceof WebAuthnError ? err.code : "bad_request");
    }
    const stored = await d.store.passkey(credentialId);
    if (!stored) return refuse("unknown_credential");
    let signCount: number;
    try {
      ({ signCount } = verifyAuthentication(d.passkeys.rp, challenge, body, stored));
    } catch (err) {
      return refuse(err instanceof WebAuthnError ? err.code : "error");
    }
    await d.store.touchPasskey(credentialId, signCount);
    const outcome = await signedIn(ctx, current.token, current.flow, stored.principalId, "passkey");
    json(ctx, 200, { redirect: outcome.next });
  }

  async function requireSession(
    ctx: HttpContext,
  ): Promise<{ token: string; session: AuthSession; principal: Principal } | null> {
    const current = await currentSession(ctx);
    if (!current) return null;
    const principal = await d.store.principal(current.session.principalId);
    return principal ? { ...current, principal } : null;
  }

  async function passkeyRegisterOptions(ctx: HttpContext) {
    const me = await requireSession(ctx);
    if (!me || !d.passkeys) return json(ctx, 401, { error: "Sign in first." });
    if ((await jsonCall(ctx, me.session.csrf)) === undefined) return json(ctx, 403, EXPIRED);
    const challenge = newToken();
    await d.ephemeral.put(`passkey-register:${me.token}`, challenge, 300);
    const existing = await d.store.passkeysOf(me.principal.id);
    const name = me.principal.label ?? "ASafariM";
    const user = { id: me.principal.id, name, displayName: name };
    json(
      ctx,
      200,
      registrationOptions(
        d.passkeys.rp,
        user,
        challenge,
        existing.map((k) => k.credentialId),
      ),
    );
  }

  async function passkeyRegisterVerify(ctx: HttpContext) {
    const me = await requireSession(ctx);
    if (!me || !d.passkeys) return json(ctx, 401, { error: "Sign in first." });
    const body = await jsonCall(ctx, me.session.csrf);
    if (body === undefined) return json(ctx, 403, EXPIRED);
    const challenge = await d.ephemeral.take(`passkey-register:${me.token}`);
    try {
      if (!challenge) throw new WebAuthnError("no_challenge");
      const k = verifyRegistration(d.passkeys.rp, challenge, body);
      if (await d.store.passkey(k.credentialId)) throw new WebAuthnError("already_registered");
      const count = (await d.store.passkeysOf(me.principal.id)).length;
      if (count >= 10) throw new WebAuthnError("too_many");
      await d.store.addPasskey(me.principal.id, { ...k, name: `Passkey ${count + 1}` });
      await audit({
        event: "passkey.registered",
        method: "passkey",
        principalId: me.principal.id,
        ipHandle: ipHandle(ctx),
      });
      json(ctx, 200, { ok: true });
    } catch (err) {
      const code = err instanceof WebAuthnError ? err.code : "error";
      await audit({
        event: "passkey.failed",
        method: "passkey",
        principalId: me.principal.id,
        detail: { reason: code, step: "register" },
      });
      json(ctx, 400, { error: "That passkey couldn't be added. Try again." });
    }
  }

  // ---- account ----------------------------------------------------------------------------------

  async function showAccount(ctx: HttpContext) {
    const me = await requireSession(ctx);
    if (!me) return seeOther(ctx, "/login");
    const done = queryValue(ctx, "done");
    render(
      ctx,
      200,
      accountPage({
        csrf: me.session.csrf,
        label: me.principal.label,
        connected: me.principal.connection === "active",
        isAdmin: me.principal.isAdmin && me.principal.connection === "active",
        passkeys: d.passkeys ? await d.store.passkeysOf(me.principal.id) : [],
        ...(done === "removed" ? { notice: "Passkey removed." } : {}),
      }),
      PASSKEY_PAGE_CSP,
    );
  }

  async function removePasskey(ctx: HttpContext) {
    const form = await readForm(ctx);
    const me = await requireSession(ctx);
    if (!me) return seeOther(ctx, "/login");
    if (!form || !sameToken(form.get("csrf"), me.session.csrf)) return expired(ctx);
    const id = (form.get("id") ?? "").slice(0, 1400);
    if (await d.store.removePasskey(me.principal.id, id)) {
      await audit({ event: "passkey.removed", method: "passkey", principalId: me.principal.id });
    }
    seeOther(ctx, "/account?done=removed");
  }

  // ---- connection requests, sign-out ------------------------------------------------------------

  async function postRequest(ctx: HttpContext) {
    const form = await readForm(ctx);
    const current = await currentSession(ctx);
    if (!current) return seeOther(ctx, "/login");
    if (!form || !sameToken(form.get("csrf"), current.session.csrf)) return expired(ctx);
    const outcome = await d.store.requestConnection(current.session.principalId);
    if (outcome === "already_connected") return seeOther(ctx, "/login");
    if (outcome === "created") {
      await audit({ event: "request.created", principalId: current.session.principalId, ipHandle: ipHandle(ctx) });
    }
    render(
      ctx,
      200,
      notConnectedPage({ csrf: current.session.csrf, pending: true, justRequested: outcome === "created" }),
    );
  }

  async function postLogout(ctx: HttpContext) {
    const form = await readForm(ctx);
    const current = await currentSession(ctx);
    if (current) {
      if (!form || !sameToken(form.get("csrf"), current.session.csrf)) return expired(ctx);
      await d.sessions.destroy(current.token);
      await audit({ event: "logout", principalId: current.session.principalId });
    }
    setCookie(ctx, AUTH_COOKIE, null, "/", 0);
    render(
      ctx,
      200,
      messagePage({
        title: "Signed out",
        message:
          "You're signed out of this sign-in page. Apps you opened keep their own session until you sign out there.",
        link: { href: "/login", label: "Sign in again" },
      }),
    );
  }

  // ---- admin ------------------------------------------------------------------------------------

  async function requireAdmin(ctx: HttpContext): Promise<{ session: AuthSession; principal: Principal } | null> {
    const current = await currentSession(ctx);
    if (!current) {
      if (ctx.method === "GET") seeOther(ctx, "/login?next=admin");
      else expired(ctx);
      return null;
    }
    const principal = await d.store.principal(current.session.principalId);
    if (!principal || principal.connection !== "active" || !principal.isAdmin) {
      await audit({ event: "admin.denied", principalId: current.session.principalId, ipHandle: ipHandle(ctx) });
      render(ctx, 403, messagePage({ title: "No access", message: "This page is for ASafariM administrators." }));
      return null;
    }
    return { session: current.session, principal };
  }

  async function showAdmin(
    ctx: HttpContext,
    admin: { session: AuthSession; principal: Principal },
    status = 200,
    error?: string,
  ) {
    const [requests, connections, recent] = await Promise.all([
      d.store.pendingRequests(),
      d.store.connections(),
      d.store.recentAudit(50),
    ]);
    const done = queryValue(ctx, "done");
    render(
      ctx,
      status,
      adminPage({
        csrf: admin.session.csrf,
        me: admin.principal.id,
        requests,
        connections,
        audit: recent,
        ...(done && NOTICES[done] ? { notice: NOTICES[done] } : {}),
        ...(error ? { error } : {}),
      }),
    );
  }

  async function adminRoute(ctx: HttpContext): Promise<boolean> {
    const { path, method } = ctx;
    if (path === "/admin" && method === "GET") {
      const admin = await requireAdmin(ctx);
      if (admin) await showAdmin(ctx, admin);
      return true;
    }
    if (
      method !== "POST" ||
      !(path === "/admin/connections" || REQUEST_ACTION.test(path) || REVOKE_ACTION.test(path))
    ) {
      return false;
    }
    const admin = await requireAdmin(ctx);
    if (!admin) return true;
    const form = await readForm(ctx);
    if (!form || !sameToken(form.get("csrf"), admin.session.csrf)) {
      expired(ctx);
      return true;
    }
    const actor = admin.principal.id;

    const request = REQUEST_ACTION.exec(path);
    if (request) {
      const decision = request[2] === "approve" ? "approved" : "rejected";
      const principalId = await d.store.decideRequest(request[1]!, decision, actor);
      seeOther(ctx, `/admin?done=${principalId ? decision : "stale"}`);
      return true;
    }
    const revoke = REVOKE_ACTION.exec(path);
    if (revoke) {
      const target = revoke[1]!;
      if (target === actor) {
        seeOther(ctx, "/admin?done=self");
        return true;
      }
      const revoked = await d.store.revoke(target, actor);
      if (revoked) {
        // Their sessions end now: the SMS sign-in's, and the provider's with every token issued under
        // them. Anything an app still holds is refused at its next token, refresh or userinfo call,
        // because the account no longer resolves (findAccount).
        await d.sessions.destroyAllFor(target);
        const ended = await d.endProviderSessions(target);
        d.log.info("connection.revoked", { reason: "admin", sessions: ended });
      }
      seeOther(ctx, `/admin?done=${revoked ? "revoked" : "stale"}`);
      return true;
    }
    const typed = (form.get("identifier") ?? "").slice(0, 256);
    const email = normalizeEmail(typed);
    const phone = email ? null : normalizePhone(typed);
    if (!email && !phone) {
      await showAdmin(ctx, admin, 400, "Enter an email address, or a mobile number with its country code (+32 …).");
      return true;
    }
    await d.store.addConnection(email ? "email" : "phone", (email ?? phone)!, actor);
    seeOther(ctx, "/admin?done=added");
    return true;
  }

  // ---- routing ----------------------------------------------------------------------------------

  async function handle(ctx: HttpContext): Promise<boolean> {
    const { path, method } = ctx;
    if (method === "GET") {
      switch (path) {
        case "/connect":
          // The QR code's target. It carries nothing secret and grants nothing: it starts a sign-in.
          seeOther(ctx, "/login");
          return true;
        case "/login":
          await startLogin(ctx);
          return true;
        case "/login/code":
          await showCode(ctx);
          return true;
        case "/login/restart":
          await restart(ctx);
          return true;
        case "/account":
          await showAccount(ctx);
          return true;
        case "/static/passkey.js":
          if (!d.passkeys) return false;
          ctx.status = 200;
          ctx.type = "application/javascript";
          ctx.set("Cache-Control", "public, max-age=300");
          ctx.set("X-Content-Type-Options", "nosniff");
          ctx.body = PASSKEY_JS;
          return true;
      }
    }
    if (method === "POST") {
      switch (path) {
        case "/login/start":
          await postStart(ctx);
          return true;
        case "/account/passkeys/remove":
          await removePasskey(ctx);
          return true;
        case "/passkeys/login/options":
          await passkeyLoginOptions(ctx);
          return true;
        case "/passkeys/login/verify":
          await passkeyLoginVerify(ctx);
          return true;
        case "/passkeys/register/options":
          await passkeyRegisterOptions(ctx);
          return true;
        case "/passkeys/register/verify":
          await passkeyRegisterVerify(ctx);
          return true;
        case "/login/resend":
          await postResend(ctx);
          return true;
        case "/login/verify":
          await postVerify(ctx);
          return true;
        case "/login/request":
          await postRequest(ctx);
          return true;
        case "/logout":
          await postLogout(ctx);
          return true;
      }
    }
    if (path === "/admin" || path.startsWith("/admin/")) return adminRoute(ctx);
    return false;
  }

  async function authorizedPrincipal(ctx: HttpContext): Promise<AuthorizedPrincipal | null> {
    const current = await currentSession(ctx);
    if (!current) return null;
    const principal = await d.store.principal(current.session.principalId);
    if (principal?.connection !== "active") return null;
    return { principalId: principal.id, authTime: current.session.authTime };
  }

  async function auditInteractionLogin(ctx: HttpContext, principalId: string, clientId: string) {
    await audit({ event: "login.granted", principalId, ipHandle: ipHandle(ctx), detail: { clientId, via: "session" } });
  }

  return {
    handle,
    authorizedPrincipal,
    auditInteractionLogin,
    loginUrl: (uid, fresh) => `/login?uid=${encodeURIComponent(uid)}${fresh ? "&fresh=1" : ""}`,
  };
}
