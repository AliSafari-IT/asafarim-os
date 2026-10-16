/**
 * The SMS sign-in method and the connections admin (id.asafarim.site).
 *
 *   QR code / link → /connect → /login → number → SMS code → verify
 *     → connected?     yes: continue (the OIDC sign-in in progress, or the home URL)
 *                      no:  "Request connection" → an admin approves → sign in again
 *
 * Authentication (the code proves the person holds the number) and
 * authorization (an active connection in the database) are separate steps;
 * neither the QR code, the URL nor the number alone grants anything, and
 * authorization is read from the database on every use, never from the
 * browser. Until the number is proved, every answer is the same whether or
 * not it is known or connected.
 */
import {
  type AuthSession,
  type AuthSessions,
  type LoginFlow,
  type LoginFlows,
  type LoginTarget,
  AUTH_SESSION_TTL_SECONDS,
  LOGIN_FLOW_TTL_SECONDS,
  newToken,
  sameToken,
} from "./auth-session.ts";
import { type HttpContext, clientIp, queryValue, readForm, sendHtml } from "./http.ts";
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
import { normalizePhone, prefixAllowed } from "./phone.ts";
import { type SmsSender, SmsError, codeMessage } from "./sms.ts";
import {
  SMS_PAGE_CSP,
  adminPage,
  codePage,
  continueToPage,
  messagePage,
  notConnectedPage,
  phonePage,
} from "./sms-pages.ts";
import { CONTINUE_PAGE_CSP } from "./pages.ts";
import type { AuditEntry, IdentityStore, Principal } from "./store.ts";

export const AUTH_COOKIE = "identity_auth";
export const FLOW_COOKIE = "identity_login";
const FLOW_COOKIE_PATH = "/login";

export interface SmsLoginDeps {
  issuer: string;
  /** Where a sign-in that didn't come from an app continues (the QR code's destination). */
  homeUrl: string;
  /** HMAC key for codes, rate-limit keys and audit handles (IDENTITY_OTP_SECRET). */
  otpSecret: string;
  allowedPrefixes: readonly string[];
  /** The most SMS the service sends per 24 h, all numbers together. */
  dailySmsLimit: number;
  store: IdentityStore;
  challenges: OtpChallenges;
  limits: RateLimiter;
  sessions: AuthSessions;
  flows: LoginFlows;
  sender: SmsSender;
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

export interface SmsLogin {
  /** Handles /connect, /login*, /logout and /admin*; false for any other path. */
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
  approved: "Request approved: that number is now connected.",
  rejected: "Request rejected.",
  revoked: "Connection revoked. Their sign-in sessions have ended.",
  added: "Number connected.",
  stale: "That request or connection had already changed. Nothing was done.",
  self: "You can't revoke your own connection.",
};

export function createSmsLogin(d: SmsLoginDeps): SmsLogin {
  const issuerHost = new URL(d.issuer).host;
  const ipHandle = (ctx: HttpContext) => blindHandle(d.otpSecret, "ip", clientIp(ctx));
  const phoneHandle = (phone: string) => blindHandle(d.otpSecret, "phone", phone);

  /** Auditing must never break a sign-in: a failed write is logged and the request goes on. */
  async function audit(entry: AuditEntry) {
    try {
      await d.store.audit({ method: "sms", ...entry });
    } catch (err) {
      d.log.error("audit.write_failed", { event: entry.event, errorCode: (err as Error).name });
    }
  }

  function render(ctx: HttpContext, status: number, html: string, csp = SMS_PAGE_CSP) {
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
      return render(ctx, 200, phonePage({ csrf: flow.csrf }));
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
    render(ctx, 200, phonePage({ csrf: flow.csrf }));
  }

  // ---- sending a code ---------------------------------------------------------------------------

  async function refuseSend(ctx: HttpContext, flow: LoginFlow, phone: string, reason: string, retryAfter: number) {
    await audit({
      event: "otp.send_refused",
      subjectHandle: phoneHandle(phone),
      ipHandle: ipHandle(ctx),
      detail: { reason },
    });
    const minutes = Math.max(1, Math.ceil(retryAfter / 60));
    const message =
      reason === "cooldown"
        ? "A code was just sent. Wait a minute before asking for another one."
        : `Too many codes were requested. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
    ctx.set("Retry-After", String(retryAfter));
    if (flow.phone === phone && flow.challengeId) {
      return render(ctx, 429, codePage({ csrf: flow.csrf, phone, error: message }));
    }
    return render(ctx, 429, phonePage({ csrf: flow.csrf, error: message, value: phone }));
  }

  async function sendCode(ctx: HttpContext, flowToken: string, flow: LoginFlow, phone: string) {
    const ip = ipHandle(ctx);
    const ph = phoneHandle(phone);
    // The cooldown first: a click on "send again" too soon doesn't use up the number's quota.
    if (!(await d.limits.cooldown("send-phone", ph, LIMITS.resendCooldownSeconds))) {
      return refuseSend(ctx, flow, phone, "cooldown", LIMITS.resendCooldownSeconds);
    }
    const checks: [string, Promise<{ allowed: boolean; retryAfter: number }>][] = [
      ["ip", d.limits.hit("send-ip", ip, LIMITS.sendPerIp)],
      ["phone", d.limits.hit("send-phone", ph, LIMITS.sendPerPhone)],
      ["phone_daily", d.limits.hit("send-phone-day", ph, LIMITS.sendPerPhoneDaily)],
    ];
    for (const [reason, check] of checks) {
      const result = await check;
      if (!result.allowed) return refuseSend(ctx, flow, phone, reason, result.retryAfter);
    }
    const budget = await d.limits.hit("send-global", "all", { max: d.dailySmsLimit, windowSeconds: 24 * 3600 });
    if (!budget.allowed) {
      d.log.warn("sms.daily_budget_reached", { reason: "global" });
      return refuseSend(ctx, flow, phone, "global_budget", budget.retryAfter);
    }

    const challengeId = newChallengeId();
    const code = generateCode();
    await d.challenges.create(challengeId, hashCode(d.otpSecret, challengeId, phone, code));
    try {
      await d.sender.send(phone, codeMessage(code, issuerHost, Math.round(OTP_TTL_SECONDS / 60)));
    } catch (err) {
      const reason = err instanceof SmsError ? err.reason : "error";
      d.log.error("sms.send_failed", { reason });
      await audit({ event: "otp.send_failed", subjectHandle: ph, ipHandle: ip, detail: { reason } });
      return render(
        ctx,
        503,
        phonePage({
          csrf: flow.csrf,
          error: "We couldn't send a code right now. Please try again in a few minutes.",
          value: phone,
        }),
      );
    }
    await d.flows.update(flowToken, { ...flow, phone, challengeId });
    await audit({ event: "otp.sent", subjectHandle: ph, ipHandle: ip });
    d.log.info("sms.code_sent", { reason: "login" });
    seeOther(ctx, "/login/code");
  }

  async function postPhone(ctx: HttpContext) {
    const form = await readForm(ctx);
    const current = await currentFlow(ctx);
    if (!form || !current || !sameToken(form.get("csrf"), current.flow.csrf)) return expired(ctx);
    const { token, flow } = current;
    const typed = (form.get("phone") ?? "").slice(0, 64);
    const phone = normalizePhone(typed);
    if (!phone) {
      return render(
        ctx,
        400,
        phonePage({
          csrf: flow.csrf,
          error: "Enter your full mobile number with its country code, for example +32 470 12 34 56.",
          value: typed,
        }),
      );
    }
    if (!prefixAllowed(phone, d.allowedPrefixes)) {
      await audit({
        event: "otp.send_refused",
        subjectHandle: phoneHandle(phone),
        ipHandle: ipHandle(ctx),
        detail: { reason: "prefix" },
      });
      return render(
        ctx,
        400,
        phonePage({
          csrf: flow.csrf,
          error: "Sign-in by SMS isn't available for numbers in this country.",
          value: typed,
        }),
      );
    }
    // A new number starts a new challenge: the previous one is simply never redeemable from this flow.
    return sendCode(ctx, token, { csrf: flow.csrf, target: flow.target }, phone);
  }

  async function postResend(ctx: HttpContext) {
    const form = await readForm(ctx);
    const current = await currentFlow(ctx);
    if (!form || !current || !sameToken(form.get("csrf"), current.flow.csrf)) return expired(ctx);
    if (!current.flow.phone) return seeOther(ctx, "/login/restart");
    return sendCode(ctx, current.token, current.flow, current.flow.phone);
  }

  async function showCode(ctx: HttpContext) {
    const current = await currentFlow(ctx);
    if (!current?.flow.phone) return seeOther(ctx, "/login");
    render(ctx, 200, codePage({ csrf: current.flow.csrf, phone: current.flow.phone }));
  }

  async function restart(ctx: HttpContext) {
    const current = await currentFlow(ctx);
    if (!current) return seeOther(ctx, "/login");
    const flow: LoginFlow = { csrf: current.flow.csrf, target: current.flow.target };
    await d.flows.update(current.token, flow);
    render(ctx, 200, phonePage({ csrf: flow.csrf }));
  }

  // ---- verifying a code -------------------------------------------------------------------------

  async function postVerify(ctx: HttpContext) {
    const form = await readForm(ctx);
    const current = await currentFlow(ctx);
    if (!form || !current || !sameToken(form.get("csrf"), current.flow.csrf)) return expired(ctx);
    const { token, flow } = current;
    const phone = flow.phone;
    if (!phone) return seeOther(ctx, "/login");
    const ip = ipHandle(ctx);
    const ph = phoneHandle(phone);

    for (const [reason, check] of [
      ["ip", d.limits.hit("verify-ip", ip, LIMITS.verifyPerIp)],
      ["phone", d.limits.hit("verify-phone", ph, LIMITS.verifyPerPhone)],
    ] as const) {
      const result = await check;
      if (!result.allowed) {
        await audit({ event: "otp.verify_refused", subjectHandle: ph, ipHandle: ip, detail: { reason } });
        ctx.set("Retry-After", String(result.retryAfter));
        return render(
          ctx,
          429,
          codePage({ csrf: flow.csrf, phone, error: "Too many tries. Wait a while, then ask for a new code." }),
        );
      }
    }

    const code = (form.get("code") ?? "").replace(/\s/g, "");
    if (!isCodeShaped(code)) {
      return render(ctx, 400, codePage({ csrf: flow.csrf, phone, error: "Enter the 6-digit code from the SMS." }));
    }
    if (!flow.challengeId) {
      return render(
        ctx,
        400,
        codePage({ csrf: flow.csrf, phone, error: "This code is no longer valid. Send a new code." }),
      );
    }
    const result = await d.challenges.verify(flow.challengeId, hashCode(d.otpSecret, flow.challengeId, phone, code));
    if (result !== "ok") {
      await audit({ event: "otp.verify_failed", subjectHandle: ph, ipHandle: ip, detail: { reason: result } });
      if (result === "wrong") {
        return render(
          ctx,
          400,
          codePage({ csrf: flow.csrf, phone, error: "That code isn't right. Check the SMS and try again." }),
        );
      }
      await d.flows.update(token, { csrf: flow.csrf, target: flow.target, phone });
      return render(
        ctx,
        400,
        codePage({
          csrf: flow.csrf,
          phone,
          error: "This code has expired or had too many wrong tries. Send a new code.",
        }),
      );
    }

    // Proved. The flow is spent; any previous session in this browser is replaced (no fixation).
    await d.flows.destroy(token);
    setCookie(ctx, FLOW_COOKIE, null, FLOW_COOKIE_PATH, 0);
    const previous = await currentSession(ctx);
    if (previous) await d.sessions.destroy(previous.token);

    const principalId = await d.store.verifiedPhoneLogin(phone);
    await audit({ event: "otp.verified", principalId, subjectHandle: ph, ipHandle: ip });
    const created = await d.sessions.create(principalId);
    setCookie(ctx, AUTH_COOKIE, created.token, "/", AUTH_SESSION_TTL_SECONDS);

    // Authorization: a separate, server-side decision.
    const principal = await d.store.principal(principalId);
    if (principal?.connection !== "active") {
      await audit({ event: "login.not_authorized", principalId, ipHandle: ip });
      d.log.info("login.not_authorized", { reason: principal?.connection ?? "unknown" });
      return seeOther(ctx, "/login");
    }
    await audit({ event: "login.granted", principalId, ipHandle: ip, detail: { target: flow.target.kind } });
    d.log.info("login.granted", { reason: flow.target.kind });
    render(ctx, 200, continueToPage(targetHref(flow.target)), CONTINUE_PAGE_CSP);
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
    const phone = normalizePhone((form.get("phone") ?? "").slice(0, 64));
    if (!phone) {
      await showAdmin(
        ctx,
        admin,
        400,
        "Enter a full mobile number with its country code, for example +32 470 12 34 56.",
      );
      return true;
    }
    await d.store.addConnection(phone, actor);
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
      }
    }
    if (method === "POST") {
      switch (path) {
        case "/login/phone":
          await postPhone(ctx);
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
