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
import { ACCOUNT_JS } from "./account-client.ts";
import { SmtpError } from "@asafarim/smtp";
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
import { type AdmissionPolicy, type AdmissionSubject, type Decision, currentAdmissions, decide } from "./admission.ts";
import type { AppLink } from "./clients.ts";
import { maskEmail, normalizeEmail } from "./email.ts";
import { type GoogleSignIn, GoogleError, pkcePair } from "./google.ts";
import { type HttpContext, clientIp, queryValue, readForm, readJson, sendHtml } from "./http.ts";
import type { Logger } from "./log.ts";
import type { Mailer } from "./mailer.ts";
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
import {
  NOTE_MAX,
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
import { currentLocale, messagesFor, msg } from "./i18n.ts";
import { CONTINUE_PAGE_CSP } from "./pages.ts";
import type { AuditEntry, IdentityMethod, IdentityStore, Principal, RequestDetails } from "./store.ts";
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
/** The browser sends the flow cookie only under this path, so every route that reads the flow lives under /login. */
const FLOW_COOKIE_PATH = "/login";

export interface SignInDeps {
  issuer: string;
  /** Where a sign-in that didn't come from an app continues (the QR code's destination). */
  homeUrl: string;
  /** The Admin console, linked in an identity admin's header. Default: none. */
  adminConsoleUrl?: string;
  /** The apps the account page offers (the named clients). Default: none. */
  apps?: readonly AppLink[];
  /**
   * Each client's admission policy, from the server-side clients file (default `restricted` for a client not
   * listed). Nothing in a request can reach it. Also tells which client ids are real.
   */
  admission?: ReadonlyMap<string, AdmissionPolicy>;
  /** HMAC key for codes, rate-limit keys and audit handles (IDENTITY_OTP_SECRET). */
  otpSecret: string;
  /** Email codes, when on: the mailer and the most emails per 24 h, all addresses together. */
  email?: { mailer: Mailer; dailyLimit: number };
  /** SMS codes, when on. */
  sms?: { sender: SmsSender; allowedPrefixes: readonly string[]; dailyLimit: number };
  /** Passkeys, when on: the relying party (the issuer's host and origin). */
  passkeys?: { rp: RelyingParty };
  /** "Continue with Google", when on. */
  google?: GoogleSignIn;
  ephemeral: Ephemeral;
  store: IdentityStore;
  challenges: OtpChallenges;
  limits: RateLimiter;
  sessions: AuthSessions;
  flows: LoginFlows;
  /** Ends the provider (OIDC) sessions of an account and revokes their grants; returns how many. */
  endProviderSessions: (principalId: string) => Promise<number>;
  /**
   * Ends THIS browser's provider (OIDC) session and revokes its grants. Without it, an app's next sign-in would be
   * answered from that session and go straight back into the same account. Default: none (tests).
   */
  endBrowserProviderSession?: (ctx: HttpContext) => Promise<void>;
  log: Logger;
}

/** A browser whose auth session belongs to a principal admission.ts allows for the client asked about. */
export interface AuthorizedPrincipal {
  principalId: string;
  /** When the code was proved (epoch seconds). */
  authTime: number;
}

export interface SignIn {
  /** Handles /connect, /login*, /logout, /account*, /passkeys*, /static/passkey.js and /admin*; false otherwise. */
  handle(ctx: HttpContext): Promise<boolean>;
  /** The authorized principal of this browser, if any (read fresh from the database). */
  authorizedPrincipal(ctx: HttpContext, clientId: string | null): Promise<AuthorizedPrincipal | null>;
  /** Records that an OIDC sign-in was completed from an existing auth session. */
  auditInteractionLogin(ctx: HttpContext, principalId: string, clientId: string): Promise<void>;
  loginUrl(uid: string, fresh: boolean): string;
  /** Records which client an interaction is for, so its login page can name the app (10 minutes). */
  rememberClient(uid: string, clientId: string): Promise<void>;
  /** Ends this browser's auth session, if any (the app-initiated sign-out, after identity's own confirmation). */
  endAuthSession(ctx: HttpContext): Promise<void>;
}

const UID = /^[\w-]{1,64}$/;
const clientKey = (uid: string) => `interaction-client:${uid}`;
const REQUEST_ACTION = /^\/admin\/requests\/([0-9a-f-]{36})\/(approve|reject)$/;
const REVOKE_ACTION = /^\/admin\/connections\/([0-9a-f-]{36})\/(revoke|reconnect)$/;
/** The admin page's notice after an action (?done=), in the admin's language. */
function notice(done: string | undefined): string | undefined {
  const notices = msg().admin.notices;
  return done && Object.hasOwn(notices, done) ? notices[done as keyof typeof notices] : undefined;
}

type Via = "email" | "sms";

interface Channel {
  method: IdentityMethod;
  normalize(input: string): string | null;
  /** The error for input that isn't an address or number, in the request's language. */
  invalid(): string;
  /** A refusal that isn't secret (a country not served), or null. */
  refuse(identifier: string): string | null;
  mask(identifier: string): string;
  send(identifier: string, code: string): Promise<void>;
  dailyLimit: number;
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
      invalid: () => msg().flow.invalidEmail,
      refuse: () => null,
      mask: maskEmail,
      // In the language of the request that asked for it.
      send: (to, code) =>
        mailer.send({
          to,
          subject: msg().mail.codeSubject(code),
          text: msg().mail.codeText(code, minutes, issuerHost),
        }),
      dailyLimit,
    };
  }
  if (d.sms) {
    const { sender, allowedPrefixes, dailyLimit } = d.sms;
    channels.sms = {
      method: "phone",
      normalize: normalizePhone,
      invalid: () => msg().flow.invalidPhone,
      refuse: (phone) => (prefixAllowed(phone, allowedPrefixes) ? null : msg().flow.smsCountry),
      mask: maskPhone,
      send: (to, code) => sender.send(to, codeMessage(code, issuerHost, minutes)),
      dailyLimit,
    };
  }
  const apps = d.apps ?? [];
  const policyOf = (clientId: string): AdmissionPolicy => d.admission?.get(clientId) ?? "restricted";
  const knownClient = (clientId: string) => apps.some((a) => a.id === clientId) || Boolean(d.admission?.has(clientId));
  /** Everything admission.ts needs to know about a person, for one client's policy. */
  const subjectOf = (p: Principal): AdmissionSubject => ({
    suspended: p.connection === "revoked",
    globalActive: p.connection === "active",
    admittedClients: currentAdmissions(p.admittedClients, policyOf),
  });
  /**
   * May this person use this client, admitting them first when the client's policy is `public`? The policy
   * comes from the server-side config and the client id from the server-side interaction, never from a request.
   * Returns the decision on the person as it stands after any admission.
   */
  async function admit(
    principalId: string,
    clientId: string | null,
  ): Promise<Decision & { principal: Principal | null }> {
    let principal = await d.store.principal(principalId);
    if (principal && clientId !== null && policyOf(clientId) === "public" && principal.connection === "none") {
      const outcome = await d.store.admitPublic(principalId, clientId);
      if (outcome === "admitted" || outcome === "already") principal = await d.store.principal(principalId);
    }
    return { ...decide(principal ? subjectOf(principal) : null, clientId), principal };
  }
  const appName = (id: string) => apps.find((a) => a.id === id)?.name ?? id;
  /** The named app this sign-in is for (only a configured client counts), shown on the login page. */
  const appOf = (target: LoginTarget) =>
    target.kind === "interaction" && target.clientId ? apps.find((a) => a.id === target.clientId) : undefined;
  const login = (flow: LoginFlow, extra: { error?: string; value?: string } = {}) =>
    loginPage({
      csrf: flow.csrf,
      app: appOf(flow.target)?.name,
      email: Boolean(channels.email),
      sms: Boolean(channels.sms),
      passkey: Boolean(d.passkeys),
      google: Boolean(d.google),
      ...extra,
    });

  /**
   * A notice by email (new requests to the admins, decisions to the requester), when email is configured.
   * Best effort: a failure is logged and never changes the outcome. Addresses are never logged.
   */
  async function notify(to: readonly string[], subject: string, text: string) {
    if (!d.email) return;
    for (const address of new Set(to)) {
      try {
        await d.email.mailer.send({ to: address, subject, text });
      } catch (err) {
        d.log.warn("notify.failed", { reason: err instanceof SmtpError ? err.reason : "error" });
      }
    }
  }

  /** What a request form asks for: known app ids only, and a note without control characters. */
  function requestDetails(form: URLSearchParams): RequestDetails {
    const known = new Set(apps.map((a) => a.id));
    const picked = [...new Set(form.getAll("app"))].filter((id) => known.has(id)).slice(0, 20);
    const note = (form.get("note") ?? "")
      .replace(/\r\n?/g, "\n")
      // Control characters (Unicode Cc), except the newline.
      .replace(/[^\n\P{Cc}]/gu, "")
      .trim()
      .slice(0, NOTE_MAX);
    return { apps: picked.sort(), note: note || null };
  }

  /** The "ask for access" page (or its pending state) for a signed-in principal who isn't connected. */
  async function accessPage(
    ctx: HttpContext,
    csrf: string,
    principal: Principal,
    extra: { justRequested?: boolean; error?: string } = {},
  ) {
    const pending = await d.store.pendingRequest(principal.id);
    render(
      ctx,
      200,
      notConnectedPage({ csrf, pending, apps, label: principal.label, methods: principal.methods, ...extra }),
    );
  }

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
        title: msg().flow.expiredTitle,
        message: msg().flow.expiredText,
        link: { href: "/login", label: msg().flow.startAgain },
      }),
    );
  }

  // ---- GET /login -----------------------------------------------------------------------------

  async function startLogin(ctx: HttpContext) {
    const uid = queryValue(ctx, "uid");
    const next = queryValue(ctx, "next");
    let target: LoginTarget =
      uid && UID.test(uid) ? { kind: "interaction", uid } : next === "admin" ? { kind: "admin" } : { kind: "home" };
    // `fresh=1`: the app asked for a new sign-in (prompt=login, max_age), so an existing session doesn't count.
    const fresh = queryValue(ctx, "fresh") === "1";

    const current = fresh ? null : await currentSession(ctx);
    if (current) {
      const principal = await d.store.principal(current.session.principalId);
      if (principal?.connection === "active") return seeOther(ctx, targetHref(target));
      if (principal) return accessPage(ctx, current.session.csrf, principal);
    }
    // Reuse this browser's flow if it has one (a reload doesn't store a new one); otherwise start one,
    // within a per-IP budget so the page can't be used to fill Redis.
    const existing = await currentFlow(ctx);
    if (target.kind === "interaction") {
      // Which app asked, as the provider recorded it for this interaction (never from the URL). A reload
      // keeps the one this browser's flow already has for the same interaction.
      const remembered = await d.ephemeral.take(clientKey(target.uid));
      const kept =
        existing?.flow.target.kind === "interaction" && existing.flow.target.uid === target.uid
          ? existing.flow.target.clientId
          : undefined;
      const clientId = remembered ?? kept;
      if (clientId && knownClient(clientId)) target = { ...target, clientId };
    }
    if (existing) {
      const flow: LoginFlow = { csrf: existing.flow.csrf, target };
      await d.flows.update(existing.token, flow);
      return render(ctx, 200, login(flow), PASSKEY_PAGE_CSP);
    }
    const budget = await d.limits.hit("flow-ip", ipHandle(ctx), LIMITS.flowsPerIp);
    if (!budget.allowed) {
      ctx.set("Retry-After", String(budget.retryAfter));
      return render(ctx, 429, messagePage({ title: msg().flow.tooManyTitle, message: msg().flow.tooManyText }));
    }
    const flow: LoginFlow = { csrf: newToken(), target };
    const token = await d.flows.create(flow);
    setCookie(ctx, FLOW_COOKIE, token, FLOW_COOKIE_PATH, LOGIN_FLOW_TTL_SECONDS);
    render(ctx, 200, login(flow), PASSKEY_PAGE_CSP);
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
    const message = reason === "cooldown" ? msg().flow.cooldown : msg().flow.tooManyCodes(mins);
    ctx.set("Retry-After", String(retryAfter));
    if (flow.identifier === identifier && flow.challengeId) {
      const masked = channels[via]!.mask(identifier);
      return render(ctx, 429, codePage({ csrf: flow.csrf, masked, via, error: message }));
    }
    return render(ctx, 429, login(flow, { error: message, value: identifier }), PASSKEY_PAGE_CSP);
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
      const reason = err instanceof SmsError || err instanceof SmtpError ? err.reason : "error";
      d.log.error("code.send_failed", { reason: `${via}:${reason}` });
      await audit({ event: "otp.send_failed", method: via, subjectHandle: subject, ipHandle: ip, detail: { reason } });
      const error = msg().flow.sendFailed;
      return render(ctx, 503, login(flow, { error, value: identifier }), PASSKEY_PAGE_CSP);
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
      return render(ctx, 400, login(flow, { error: channel.invalid(), value: typed }), PASSKEY_PAGE_CSP);
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
      return render(ctx, 400, login(flow, { error: refused, value: typed }), PASSKEY_PAGE_CSP);
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
    render(ctx, 200, login(flow), PASSKEY_PAGE_CSP);
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
    method: "email" | "sms" | "passkey" | "google",
  ): Promise<{ authorized: boolean; next: string }> {
    await d.flows.destroy(flowToken);
    setCookie(ctx, FLOW_COOKIE, null, FLOW_COOKIE_PATH, 0);
    const previous = await currentSession(ctx);
    if (previous) await d.sessions.destroy(previous.token);
    const created = await d.sessions.create(principalId);
    setCookie(ctx, AUTH_COOKIE, created.token, "/", AUTH_SESSION_TTL_SECONDS);

    const ip = ipHandle(ctx);
    // The client is the one the provider recorded for this interaction (server-side), never a request value.
    const clientId = flow.target.kind === "interaction" ? (flow.target.clientId ?? null) : null;
    const decision = await admit(principalId, clientId);
    if (!decision.allow) {
      await audit({
        event: "login.not_authorized",
        method,
        principalId,
        ipHandle: ip,
        detail: { ...(clientId ? { clientId } : {}), reason: decision.reason },
      });
      d.log.info("login.not_authorized", { reason: decision.reason });
      return { authorized: false, next: "/login" };
    }
    await audit({
      event: "login.granted",
      method,
      principalId,
      ipHandle: ip,
      detail: {
        target: flow.target.kind,
        ...(clientId ? { clientId } : {}),
        via: decision.via,
      },
    });
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
        return page(429, msg().flow.tooManyCodeTries);
      }
    }

    const code = (form.get("code") ?? "").replace(/\s/g, "");
    if (!isCodeShaped(code)) return page(400, msg().flow.enterCode(via));
    if (!flow.challengeId) return page(400, msg().flow.noLongerValid);
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
      if (result === "wrong") return page(400, msg().flow.wrongCode(via));
      await d.flows.update(token, { csrf: flow.csrf, target: flow.target, via, identifier });
      return page(400, msg().flow.codeExpired);
    }

    const verified = await d.store.verifiedLogin(channel.method, identifier);
    if (verified.kind !== "ok") {
      // The identifier changed hands under us. Generic and retryable; nothing was created or changed.
      await audit({
        event: "otp.verify_failed",
        method: via,
        subjectHandle: subject,
        ipHandle: ip,
        detail: { reason: verified.reason },
      });
      return page(409, msg().flow.tryAgain);
    }
    const principalId = verified.principalId;
    await audit({ event: "otp.verified", method: via, principalId, subjectHandle: subject, ipHandle: ip });
    const outcome = await signedIn(ctx, token, flow, principalId, via);
    if (!outcome.authorized) return seeOther(ctx, outcome.next);
    render(ctx, 200, continueToPage(outcome.next), CONTINUE_PAGE_CSP);
  }

  // ---- Continue with Google ---------------------------------------------------------------------

  const googleRedirectUri = `${d.issuer}/login/google/callback`;
  const googleKey = (flowToken: string) => `google:${flowToken}`;

  /**
   * GET /login/google: a plain link, not a form, so no form-action applies to the hop to Google. It needs this
   * browser's login flow; the state, nonce and PKCE verifier are bound to that flow (single use, 10 minutes).
   */
  async function googleStart(ctx: HttpContext) {
    const current = await currentFlow(ctx);
    if (!current || !d.google) return seeOther(ctx, "/login");
    const budget = await d.limits.hit("google-ip", ipHandle(ctx), LIMITS.flowsPerIp);
    if (!budget.allowed) {
      ctx.set("Retry-After", String(budget.retryAfter));
      return render(ctx, 429, messagePage({ title: msg().flow.tooManyTitle, message: msg().flow.tooManyText }));
    }
    const state = newToken();
    const nonce = newToken();
    const { verifier, challenge } = pkcePair();
    await d.ephemeral.put(googleKey(current.token), JSON.stringify({ state, nonce, verifier }), 600);
    seeOther(ctx, d.google.authorizeUrl({ redirectUri: googleRedirectUri, state, nonce, codeChallenge: challenge }));
  }

  /** GET /login/google/callback: Google sends the browser back here with a code (or an error). */
  async function googleCallback(ctx: HttpContext) {
    const current = await currentFlow(ctx);
    if (!current || !d.google) return expired(ctx);
    const ip = ipHandle(ctx);
    const pending = await d.ephemeral.take(googleKey(current.token));
    const fail = async (reason: string, message: string) => {
      await audit({ event: "google.failed", method: "google", ipHandle: ip, detail: { reason } });
      d.log.info("google.failed", { reason });
      render(ctx, 400, login(current.flow, { error: message }), PASSKEY_PAGE_CSP);
    };
    const error = queryValue(ctx, "error");
    if (error) {
      return fail(
        error === "access_denied" ? "cancelled" : "provider_error",
        error === "access_denied" ? msg().flow.googleCancelled : msg().flow.googleFailed,
      );
    }
    let saved: { state: string; nonce: string; verifier: string } | null = null;
    try {
      saved = pending ? (JSON.parse(pending) as { state: string; nonce: string; verifier: string }) : null;
    } catch {
      saved = null;
    }
    const state = queryValue(ctx, "state");
    const code = queryValue(ctx, "code");
    if (!saved || !sameToken(state, saved.state) || !code || code.length > 2048) {
      return fail("state_mismatch", msg().flow.googleExpired);
    }
    const limit = await d.limits.hit("verify-ip", ip, LIMITS.verifyPerIp);
    if (!limit.allowed) {
      ctx.set("Retry-After", String(limit.retryAfter));
      return fail("rate_limited", msg().flow.tooManyTries);
    }
    let who;
    try {
      who = await d.google.finish({
        code,
        redirectUri: googleRedirectUri,
        codeVerifier: saved.verifier,
        nonce: saved.nonce,
      });
    } catch (err) {
      const reason = err instanceof GoogleError ? err.reason : "error";
      return fail(reason, msg().flow.googleFailed);
    }
    const verified = await d.store.verifiedGoogleLogin(who.subject, who.email, who.authoritative);
    if (verified.kind !== "ok") return fail("identifier_conflict", msg().flow.tryAgain);
    const principalId = verified.principalId;
    await audit({
      event: "google.verified",
      method: "google",
      principalId,
      ipHandle: ip,
      detail: { linked: verified.linked === true },
    });
    const outcome = await signedIn(ctx, current.token, current.flow, principalId, "google");
    // A top-level GET (Google's redirect), not a form submission: a plain redirect may leave for the app's domain.
    seeOther(ctx, outcome.next);
  }

  // ---- passkeys ---------------------------------------------------------------------------------

  function json(ctx: HttpContext, status: number, body: unknown) {
    ctx.status = status;
    ctx.type = "application/json";
    ctx.set("Cache-Control", "no-store");
    ctx.set("X-Content-Type-Options", "nosniff");
    ctx.body = JSON.stringify(body);
  }

  const expiredJson = () => ({ error: msg().flow.reload });

  /** JSON calls from our own script: the page's CSRF token in a header, and a JSON body. */
  async function jsonCall(ctx: HttpContext, csrf: string): Promise<unknown> {
    const header = ctx.get("x-csrf-token");
    if (!sameToken(header || undefined, csrf)) return undefined;
    return (await readJson(ctx)) ?? undefined;
  }

  async function passkeyLoginOptions(ctx: HttpContext) {
    const current = await currentFlow(ctx);
    if (!current || !d.passkeys) return json(ctx, 400, expiredJson());
    if ((await jsonCall(ctx, current.flow.csrf)) === undefined) return json(ctx, 403, expiredJson());
    const challenge = newToken();
    await d.ephemeral.put(`passkey-login:${current.token}`, challenge, 300);
    json(ctx, 200, authenticationOptions(d.passkeys.rp, challenge));
  }

  async function passkeyLoginVerify(ctx: HttpContext) {
    const current = await currentFlow(ctx);
    if (!current || !d.passkeys) return json(ctx, 400, expiredJson());
    const body = await jsonCall(ctx, current.flow.csrf);
    if (body === undefined) return json(ctx, 403, expiredJson());
    const ip = ipHandle(ctx);
    const limit = await d.limits.hit("verify-ip", ip, LIMITS.verifyPerIp);
    if (!limit.allowed) return json(ctx, 429, { error: msg().flow.tooManyTries });
    const challenge = await d.ephemeral.take(`passkey-login:${current.token}`);
    const refuse = async (code: string) => {
      await audit({ event: "passkey.failed", method: "passkey", ipHandle: ip, detail: { reason: code } });
      json(ctx, 400, { error: msg().flow.passkeyUnusable });
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

  /**
   * Who is signed in here, for the OS home page (asafarim.site) to show an account menu instead of "Sign in".
   * Read with `fetch(…, { credentials: "include" })` from the home page's origin only (CORS, no other origin
   * gets an Allow-Origin header). It returns the label and initials, never the id, a token or a session.
   */
  async function whoami(ctx: HttpContext) {
    const home = new URL(d.homeUrl).origin;
    ctx.set("Vary", "Origin");
    ctx.set("Cache-Control", "no-store");
    if (ctx.get("Origin") === home) {
      ctx.set("Access-Control-Allow-Origin", home);
      ctx.set("Access-Control-Allow-Credentials", "true");
    }
    const me = await requireSession(ctx);
    if (!me) return json(ctx, 200, { signedIn: false });
    return json(ctx, 200, {
      signedIn: true,
      label: me.principal.label,
      initials: initialsOf(me.principal.label),
      connected: me.principal.connection === "active",
      // The home page offers the Admin console to an identity admin (the console checks core.admin itself).
      admin: me.principal.isAdmin && me.principal.connection === "active",
    });
  }

  async function passkeyRegisterOptions(ctx: HttpContext) {
    const me = await requireSession(ctx);
    if (!me || !d.passkeys) return json(ctx, 401, { error: msg().flow.signInFirst });
    if ((await jsonCall(ctx, me.session.csrf)) === undefined) return json(ctx, 403, expiredJson());
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
    if (!me || !d.passkeys) return json(ctx, 401, { error: msg().flow.signInFirst });
    const body = await jsonCall(ctx, me.session.csrf);
    if (body === undefined) return json(ctx, 403, expiredJson());
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
      json(ctx, 400, { error: msg().flow.passkeyNotAdded });
    }
  }

  // ---- account ----------------------------------------------------------------------------------

  async function showAccount(ctx: HttpContext) {
    const me = await requireSession(ctx);
    if (!me) return seeOther(ctx, "/login");
    const done = queryValue(ctx, "done");
    const notices: Record<string, string> = {
      removed: msg().flow.removed,
      requested: msg().flow.requested,
      unchanged: msg().flow.unchanged,
    };
    render(
      ctx,
      200,
      accountPage({
        csrf: me.session.csrf,
        apps,
        accountId: me.principal.id,
        label: me.principal.label,
        initials: initialsOf(me.principal.label),
        methods: me.principal.methods,
        pending: await d.store.pendingRequest(me.principal.id),
        connected: me.principal.connection === "active",
        isAdmin: me.principal.isAdmin && me.principal.connection === "active",
        ...(d.adminConsoleUrl ? { adminConsoleUrl: d.adminConsoleUrl } : {}),
        passkeys: d.passkeys ? await d.store.passkeysOf(me.principal.id) : [],
        ...(done && notices[done] ? { notice: notices[done] } : {}),
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

  /**
   * POST /login/request: ask for access (which apps, and a note). Someone not connected asks to be connected;
   * a connected person asks for more apps. Either way an admin decides; nothing is granted here.
   */
  async function postRequest(ctx: HttpContext) {
    const form = await readForm(ctx);
    const me = await requireSession(ctx);
    if (!me) return seeOther(ctx, "/login");
    if (!form || !sameToken(form.get("csrf"), me.session.csrf)) return expired(ctx);
    const connected = me.principal.connection === "active";
    const details = { ...requestDetails(form), locale: currentLocale() };
    if (connected && details.apps.length === 0) return seeOther(ctx, "/account?done=unchanged");
    const outcome = await d.store.requestConnection(me.principal.id, details);
    if (outcome === "already_connected") return seeOther(ctx, "/account");
    if (outcome === "created" || outcome === "updated") {
      await audit({
        event: outcome === "created" ? "request.created" : "request.updated",
        principalId: me.principal.id,
        ipHandle: ipHandle(ctx),
        detail: { apps: details.apps.join(","), note: details.note !== null },
      });
    }
    if (outcome === "created") {
      const asked = details.apps.length ? details.apps.map(appName).join(", ") : "an account (no app picked)";
      await notify(
        await d.store.adminEmails(),
        "ASafariM: new access request",
        `${me.principal.label ?? "Someone"} asked for access to ASafariM.\n\nApps: ${asked}\n${
          details.note ? `Note: ${details.note}\n` : ""
        }\nReview it at ${d.issuer}/admin\n`,
      );
    }
    if (connected) return seeOther(ctx, `/account?done=${outcome === "already_pending" ? "unchanged" : "requested"}`);
    await accessPage(ctx, me.session.csrf, me.principal, { justRequested: outcome === "created" });
  }

  async function postLogout(ctx: HttpContext) {
    const form = await readForm(ctx);
    const current = await currentSession(ctx);
    if (current && (!form || !sameToken(form.get("csrf"), current.session.csrf))) return expired(ctx);
    await endAuthSession(ctx);
    // The provider's session too: otherwise an app's next sign-in is answered from it, without asking.
    await d.endBrowserProviderSession?.(ctx);
    render(
      ctx,
      200,
      messagePage({
        title: msg().signedOut.title,
        message: msg().flow.signedOutText,
        link: { href: "/login", label: msg().signedOut.again },
      }),
    );
  }

  async function endAuthSession(ctx: HttpContext) {
    const current = await currentSession(ctx);
    if (current) {
      await d.sessions.destroy(current.token);
      await audit({ event: "logout", principalId: current.session.principalId });
    }
    setCookie(ctx, AUTH_COOKIE, null, "/", 0);
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
      render(ctx, 403, messagePage({ title: msg().flow.noAccessTitle, message: msg().flow.noAccessText }));
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
        apps,
        ...(d.adminConsoleUrl ? { adminConsoleUrl: d.adminConsoleUrl } : {}),
        ...(notice(done) ? { notice: notice(done)! } : {}),
        grantHint: done === "approved",
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
      const asked = (await d.store.pendingRequests()).find((r) => r.id === request[1]);
      const principalId = await d.store.decideRequest(request[1]!, decision, actor);
      if (principalId && asked?.label?.includes("@")) {
        const names = asked.apps.map(appName).join(", ");
        // In the language the person asked in (English for requests from before languages).
        const mail = messagesFor(asked.locale).mail;
        await notify(
          [asked.label],
          decision === "approved" ? mail.approvedSubject : mail.rejectedSubject,
          decision === "approved" ? mail.approvedText(names, d.issuer) : mail.rejectedText(names, d.issuer),
        );
      }
      seeOther(ctx, `/admin?done=${principalId ? decision : "stale"}`);
      return true;
    }
    const revoke = REVOKE_ACTION.exec(path);
    if (revoke?.[2] === "reconnect") {
      const done = await d.store.reconnect(revoke[1]!, actor);
      seeOther(ctx, `/admin?done=${done ? "reconnected" : "stale"}`);
      return true;
    }
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
      await showAdmin(ctx, admin, 400, msg().admin.enterIdentifier);
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
        case "/":
          // id.asafarim.site itself: the account page, which sends a signed-out visitor to sign in.
          seeOther(ctx, "/account");
          return true;
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
        case "/login/google":
          if (!d.google) return false;
          await googleStart(ctx);
          return true;
        case "/login/google/callback":
          if (!d.google) return false;
          await googleCallback(ctx);
          return true;
        case "/account":
          await showAccount(ctx);
          return true;
        case "/whoami":
          await whoami(ctx);
          return true;
        case "/static/account.js":
          ctx.status = 200;
          ctx.type = "application/javascript";
          ctx.set("Cache-Control", "public, max-age=300");
          ctx.set("X-Content-Type-Options", "nosniff");
          ctx.body = ACCOUNT_JS;
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
        case "/login/passkey/options":
          await passkeyLoginOptions(ctx);
          return true;
        case "/login/passkey/verify":
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

  async function authorizedPrincipal(ctx: HttpContext, clientId: string | null): Promise<AuthorizedPrincipal | null> {
    const current = await currentSession(ctx);
    if (!current) return null;
    // The same decision as at sign-in and in findAccount; a public client admits here too (a person signed in
    // from another app arrives with a session and no sign-in step of their own).
    const decision = await admit(current.session.principalId, clientId);
    if (!decision.allow || !decision.principal) return null;
    return { principalId: decision.principal.id, authTime: current.session.authTime };
  }

  async function auditInteractionLogin(ctx: HttpContext, principalId: string, clientId: string) {
    await audit({ event: "login.granted", principalId, ipHandle: ipHandle(ctx), detail: { clientId, via: "session" } });
  }

  return {
    handle,
    authorizedPrincipal,
    auditInteractionLogin,
    endAuthSession,
    loginUrl: (uid, fresh) => `/login?uid=${encodeURIComponent(uid)}${fresh ? "&fresh=1" : ""}`,
    rememberClient: async (uid, clientId) => {
      if (UID.test(uid) && clientId) await d.ephemeral.put(clientKey(uid), clientId, LOGIN_FLOW_TTL_SECONDS);
    },
  };
}

/** Up to two letters for an avatar: "ali.safari@x.com" → "AS", "ali@x.com" → "AL", a phone number → "#". */
export function initialsOf(label: string | null): string {
  if (!label) return "?";
  const local = label.includes("@") ? label.slice(0, label.indexOf("@")) : label;
  const words = local.split(/[^\p{L}\p{N}]+/u).filter((w) => /\p{L}/u.test(w));
  if (words.length === 0) return "#";
  const first = words[0]!;
  const second = words[1];
  return (second ? first[0]! + second[0]! : first.slice(0, 2)).toUpperCase();
}
