/**
 * The OIDC provider (panva/oidc-provider) for id.asafarim.site. How a person
 * signs in is a login method chosen by config (IDENTITY_LOGIN_METHOD):
 *
 * - `hub`: login delegated to Hub (ADR 0002, Addendum A);
 * - `local`: the service's own sign-in (email codes, passkeys, SMS), with
 *   connections approved by an admin (sign-in.ts).
 *
 * Whatever the method, an interaction is finished only for an account that
 * `findAccount` accepts, and tokens are issued only for such an account.
 *
 * Policy: authorization code flow only, PKCE (S256) required for every client,
 * ID tokens ES256, access tokens 10 min, refresh tokens only with
 * `offline_access` and rotated on every use, RP-initiated + back-channel logout.
 */
import { randomBytes } from "node:crypto";
import Provider, { type Configuration } from "oidc-provider";
import type { CryptoKey, JWK, KeyObject } from "jose";
import type { AuditApi } from "./audit-api.ts";
import type { AccountStore } from "./accounts.ts";
import type { OidcClient } from "./clients.ts";
import { HandoffError, issueTicket, verifyAssertion, type ReplayGuard } from "./handoff.ts";
import { type HttpContext, readForm, sendHtml } from "./http.ts";
import type { Logger } from "./log.ts";
import {
  CONTINUE_PAGE_CSP,
  FAVICON_SVG,
  THEME_JS,
  continuePage,
  errorPage,
  loggedOutPage,
  logoutPage,
} from "./pages.ts";
import { PENDING_TTL_SECONDS, hashSecret, type PendingLogins } from "./pending.ts";
import type { SignIn } from "./sign-in.ts";

export const ACCESS_TOKEN_TTL = 600;
export const SCOPES = ["openid", "offline_access", "email", "profile", "roles"];

export interface ProviderDeps {
  issuer: string;
  jwks: { keys: JWK[] };
  cookieKeys: string[];
  clients: OidcClient[];
  /** Default `hub`. */
  loginMethod?: "hub" | "local";
  /** `hub` only: the hand-off keys and Hub's continue URL. */
  handoffPrivateKey?: CryptoKey | KeyObject;
  hubPublicKey?: CryptoKey | KeyObject;
  hubContinueUrl?: string;
  /** `local` only: the service's own sign-in (email codes, passkeys, SMS) and the connections admin. */
  signIn?: SignIn;
  /** `local` only: the sign-in trail for the Admin console (audit-api.ts). */
  auditApi?: AuditApi;
  trustProxy: boolean;
  // oidc-provider's adapter contract is a constructor taking the model name.
  adapter: Configuration["adapter"];
  accounts: AccountStore;
  /** `hub` only. */
  replay?: ReplayGuard;
  /** `hub` only: verified logins waiting for /interaction/:uid/complete in the starting browser. */
  pending?: PendingLogins;
  /** Readiness probes for /readyz (Redis, accounts DB). */
  readiness: () => Promise<Record<string, boolean>>;
  log: Logger;
  /**
   * Tests only: replaces oidc-provider's outbound fetch. Production never sets
   * it, so back-channel logout keeps oidc-provider's SSRF protection (requests
   * to loopback/private addresses are refused).
   */
  testOnlyFetch?: Configuration["fetch"];
}

/** The completion cookie, scoped to one interaction's /complete path. */
const COMPLETION_COOKIE = "identity_complete";
const completePath = (uid: string) => `/interaction/${uid}/complete`;

interface HubLogin {
  handoffPrivateKey: CryptoKey | KeyObject;
  hubPublicKey: CryptoKey | KeyObject;
  hubContinueUrl: string;
  replay: ReplayGuard;
  pending: PendingLogins;
}

/** The login method's own dependencies, checked once: a misconfiguration fails at startup, not at a sign-in. */
function loginMethodOf(deps: ProviderDeps): { method: "hub"; hub: HubLogin } | { method: "local"; signIn: SignIn } {
  if ((deps.loginMethod ?? "hub") === "local") {
    if (!deps.signIn) throw new Error("the local login method needs its SignIn");
    return { method: "local", signIn: deps.signIn };
  }
  const { handoffPrivateKey, hubPublicKey, hubContinueUrl, replay, pending } = deps;
  if (!handoffPrivateKey || !hubPublicKey || !hubContinueUrl || !replay || !pending) {
    throw new Error(
      "the hub login method needs the hand-off keys, Hub's continue URL, a replay guard and pending logins",
    );
  }
  return { method: "hub", hub: { handoffPrivateKey, hubPublicKey, hubContinueUrl, replay, pending } };
}

/**
 * `prompt=login` asks for a NEW sign-in: with the SMS method, only an auth session proved this
 * recently satisfies it (the person was just sent through the code step for this very request).
 */
const FRESH_LOGIN_SLACK_SECONDS = 120;

export function createProvider(deps: ProviderDeps): Provider {
  const { log } = deps;
  const login = loginMethodOf(deps);

  const configuration: Configuration = {
    adapter: deps.adapter,
    ...(deps.testOnlyFetch ? { fetch: deps.testOnlyFetch } : {}),
    clients: deps.clients as unknown as Configuration["clients"],
    jwks: deps.jwks as Configuration["jwks"],
    cookies: {
      keys: deps.cookieKeys,
      long: { signed: true, httpOnly: true, sameSite: "lax" },
      short: { signed: true, httpOnly: true, sameSite: "lax" },
    },
    responseTypes: ["code"],
    pkce: { required: () => true },
    scopes: SCOPES,
    // The ID token carries every claim its scopes allow (email, name, roles), not only `sub`: Auth.js reads the
    // signed-in person from the ID token and never calls userinfo, so apps would otherwise show a bare id.
    conformIdTokenClaims: false,
    claims: {
      openid: ["sub"],
      email: ["email"],
      profile: ["name", "picture"],
      roles: ["roles"],
    },
    clientDefaults: {
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      id_token_signed_response_alg: "ES256",
    },
    enabledJWA: {
      idTokenSigningAlgValues: ["ES256"],
      userinfoSigningAlgValues: ["ES256"],
    },
    ttl: {
      AccessToken: ACCESS_TOKEN_TTL,
      AuthorizationCode: 60,
      IdToken: 3600,
      Interaction: 600,
      Grant: 14 * 24 * 3600,
      Session: 14 * 24 * 3600,
      RefreshToken: 14 * 24 * 3600,
    },
    // Refresh tokens are issued only with offline_access (oidc-provider's
    // default) and rotate on every use.
    rotateRefreshToken: true,
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      backchannelLogout: { enabled: true },
      rpInitiatedLogout: {
        enabled: true,
        logoutSource: async (ctx, form) => sendHtml(ctx, 200, logoutPage(form)),
        postLogoutSuccessSource: async (ctx) => sendHtml(ctx, 200, loggedOutPage()),
      },
    },
    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
    // Every client is a first-party ASafariM app: no consent screen. The grant
    // covers exactly the OIDC scopes the client asked for.
    loadExistingGrant: async (ctx) => {
      const { oidc } = ctx;
      const clientId = oidc.client!.clientId;
      const existing = oidc.result?.consent?.grantId ?? oidc.session!.grantIdFor(clientId);
      if (existing) {
        const grant = await oidc.provider.Grant.find(existing);
        if (grant) {
          // A later request may ask for more scopes (e.g. offline_access): extend.
          grant.addOIDCScope([...oidc.requestParamOIDCScopes].join(" "));
          await grant.save();
          return grant;
        }
      }
      const grant = new oidc.provider.Grant({ clientId, accountId: oidc.session!.accountId! });
      grant.addOIDCScope([...oidc.requestParamOIDCScopes].join(" "));
      await grant.save();
      return grant;
    },
    findAccount: async (_ctx, sub) => {
      const account = await deps.accounts.find(sub);
      // Inactive or unknown → no account → no tokens.
      if (!account || !account.isActive) return undefined;
      return {
        accountId: account.sub,
        claims: async () => ({
          sub: account.sub,
          email: account.email ?? undefined,
          name: account.name ?? undefined,
          picture: account.picture ?? undefined,
          roles: account.roles,
        }),
      };
    },
    renderError: async (ctx, out) => {
      log.warn("oidc.error_page", { errorCode: String(out.error ?? "server_error") });
      sendHtml(
        ctx,
        ctx.status >= 400 ? ctx.status : 400,
        errorPage({
          message: "The sign-in request couldn't be processed.",
          code: String(out.error ?? "server_error"),
        }),
      );
    },
  };

  const provider = new Provider(deps.issuer, configuration);
  provider.proxy = deps.trustProxy;

  provider.on("server_error", (_ctx, err) => log.error("oidc.server_error", { errorCode: err.name }));
  provider.on("grant.error", (_ctx, err) =>
    log.warn("oidc.grant_error", { errorCode: (err as { error?: string }).error ?? err.name }),
  );
  provider.on("backchannel.error", (_ctx, err, client) =>
    log.warn("oidc.backchannel_error", { errorCode: err.name, clientId: client.clientId }),
  );

  provider.use(async (ctx, next) => {
    const path = ctx.path;

    if (path === "/healthz" && ctx.method === "GET") {
      ctx.body = { ok: true };
      return;
    }

    if (path === "/favicon.svg" && ctx.method === "GET") {
      ctx.type = "image/svg+xml";
      ctx.set("Cache-Control", "public, max-age=86400");
      ctx.set("X-Content-Type-Options", "nosniff");
      ctx.body = FAVICON_SVG;
      return;
    }

    // @asafarim/theme's light/dark script, which every page but the hand-off runs in <head>.
    if (path === "/static/theme.js" && ctx.method === "GET") {
      ctx.type = "application/javascript";
      ctx.set("Cache-Control", "public, max-age=300");
      ctx.set("X-Content-Type-Options", "nosniff");
      ctx.body = THEME_JS;
      return;
    }

    if (path === "/readyz" && ctx.method === "GET") {
      let checks: Record<string, boolean>;
      try {
        checks = await deps.readiness();
      } catch {
        checks = { probes: false };
      }
      const ok = Object.values(checks).every(Boolean);
      ctx.status = ok ? 200 : 503;
      ctx.body = { ok, checks };
      return;
    }

    // GET /interaction/:uid — the provider needs a login: hand off to Hub.
    const start = /^\/interaction\/([\w-]+)$/.exec(path);
    if (start && ctx.method === "GET") {
      const uid = start[1]!;
      let details;
      try {
        details = await provider.interactionDetails(ctx.req, ctx.res);
      } catch {
        sendHtml(ctx, 400, errorPage({ message: "This sign-in link has expired.", code: "interaction_expired" }));
        return;
      }
      if (details.uid !== uid) {
        sendHtml(
          ctx,
          400,
          errorPage({ message: "This sign-in link doesn't match your session.", code: "interaction_mismatch" }),
        );
        return;
      }
      if (details.prompt.name === "consent" && details.session?.accountId) {
        // First-party apps: consent is implied. This prompt only appears when
        // the client asked for it (prompt=consent, required for offline_access).
        const clientId = String(details.params.client_id);
        const grant = details.grantId
          ? ((await provider.Grant.find(details.grantId)) ??
            new provider.Grant({ clientId, accountId: details.session.accountId }))
          : new provider.Grant({ clientId, accountId: details.session.accountId });
        grant.addOIDCScope(String(details.params.scope ?? "openid"));
        const grantId = await grant.save();
        log.info("interaction.consent", { uid, clientId });
        await provider.interactionFinished(
          ctx.req,
          ctx.res,
          { consent: { grantId } },
          { mergeWithLastSubmission: true },
        );
        ctx.respond = false;
        return;
      }
      if (details.prompt.name !== "login") {
        // With loadExistingGrant there is no consent prompt; anything else is unexpected.
        log.warn("interaction.unexpected_prompt", { uid, reason: details.prompt.name });
        sendHtml(
          ctx,
          400,
          errorPage({ message: "The sign-in request couldn't be processed.", code: "unexpected_prompt" }),
        );
        return;
      }
      if (login.method === "local") {
        // Finish the login if this browser has an SMS auth session whose principal is connected
        // (and, when the app asked for a new sign-in, a recent one); otherwise send it to the SMS
        // sign-in, which comes back to this URL when done.
        const sms = login.signIn;
        const reasons: string[] = details.prompt.reasons ?? [];
        const maxAge = Number(details.params.max_age);
        const authorized = await sms.authorizedPrincipal(ctx as unknown as HttpContext);
        const age = authorized ? Math.floor(Date.now() / 1000) - authorized.authTime : Infinity;
        const fresh =
          (!reasons.includes("login_prompt") || age <= FRESH_LOGIN_SLACK_SECONDS) &&
          (!reasons.includes("max_age") || (Number.isFinite(maxAge) && age <= maxAge));
        if (!authorized || !fresh) {
          log.info("interaction.sms_login", { uid, reason: authorized ? "fresh_login" : "no_session" });
          ctx.set("Cache-Control", "no-store");
          ctx.redirect(sms.loginUrl(uid, Boolean(authorized)));
          return;
        }
        const clientId = String(details.params.client_id ?? "");
        await sms.auditInteractionLogin(ctx as unknown as HttpContext, authorized.principalId, clientId);
        log.info("interaction.login", { uid, clientId });
        await provider.interactionFinished(
          ctx.req,
          ctx.res,
          { login: { accountId: authorized.principalId, ts: authorized.authTime } },
          { mergeWithLastSubmission: false },
        );
        ctx.respond = false;
        return;
      }
      const ticket = await issueTicket(uid, login.hub.handoffPrivateKey);
      const target = new URL(login.hub.hubContinueUrl);
      target.searchParams.set("ticket", ticket);
      log.info("interaction.handoff", { uid, clientId: String(details.params.client_id ?? "") });
      ctx.set("Cache-Control", "no-store");
      ctx.redirect(target.href);
      return;
    }

    // POST /interaction/:uid/hub — Hub's signed assertion comes back.
    const back = /^\/interaction\/([\w-]+)\/hub$/.exec(path);
    if (back && ctx.method === "POST" && login.method === "hub") {
      const uid = back[1]!;
      // This is a cross-site POST (hub.asafarim.com → id.asafarim.site), so the
      // SameSite=Lax interaction cookie isn't sent and the posting browser can't
      // be tied to the one that started the interaction here. The assertion is
      // verified now, but the login is finished by GET /interaction/:uid/complete
      // (a top-level GET, which does carry the interaction cookie).
      const interaction = await provider.Interaction.find(uid);
      if (!interaction) {
        sendHtml(ctx, 400, errorPage({ message: "This sign-in has expired.", code: "interaction_expired" }));
        return;
      }
      const form = await readForm(ctx);
      const assertion = form?.get("assertion");
      if (!assertion) {
        sendHtml(ctx, 400, errorPage({ message: "Hub didn't send a sign-in assertion.", code: "missing_assertion" }));
        return;
      }
      let sub: string;
      try {
        ({ sub } = await verifyAssertion(assertion, {
          hubPublicKey: login.hub.hubPublicKey,
          uid,
          replay: login.hub.replay,
        }));
      } catch (err) {
        const code = err instanceof HandoffError ? err.code : "invalid";
        log.warn("interaction.assertion_refused", { uid, reason: code });
        sendHtml(ctx, 400, errorPage({ message: "Your sign-in couldn't be verified.", code: `assertion_${code}` }));
        return;
      }
      const account = await deps.accounts.find(sub);
      if (!account || !account.isActive) {
        log.warn("interaction.account_refused", { uid, reason: account ? "inactive" : "unknown" });
        sendHtml(ctx, 403, errorPage({ message: "This account can't sign in.", code: "account_inactive" }));
        return;
      }
      // Don't finish here: this POST can't prove it comes from the browser
      // that started the interaction. Park the verified login and hand THIS
      // browser a completion secret; /complete finishes only where both the
      // provider's interaction cookie and this secret are present.
      const secret = randomBytes(32).toString("base64url");
      await login.hub.pending.put(uid, { sub, completionHash: hashSecret(secret) }, PENDING_TTL_SECONDS);
      ctx.cookies.set(COMPLETION_COOKIE, secret, {
        path: completePath(uid),
        httpOnly: true,
        sameSite: "lax",
        secure: ctx.secure,
        maxAge: PENDING_TTL_SECONDS * 1000,
        signed: false,
        overwrite: true,
      });
      log.info("interaction.assertion_accepted", { uid });
      // 200 with a page that navigates to /complete, NOT a redirect: Hub's assertion page has
      // `form-action <issuer>`, which Chromium applies to every redirect in the chain (asafarim-os#40).
      ctx.status = 200;
      ctx.type = "html";
      ctx.set({
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": CONTINUE_PAGE_CSP,
      });
      ctx.body = continuePage(uid);
      return;
    }

    // GET /interaction/:uid/complete — finish only in the browser that started
    // the interaction AND posted the assertion.
    const complete = /^\/interaction\/([\w-]+)\/complete$/.exec(path);
    if (complete && ctx.method === "GET" && login.method === "hub") {
      const uid = complete[1]!;
      ctx.set("Cache-Control", "no-store");
      const secret = ctx.cookies.get(COMPLETION_COOKIE, { signed: false });
      ctx.cookies.set(COMPLETION_COOKIE, null, { path: completePath(uid), signed: false });
      // Consumed only when this browser holds the matching secret (atomic
      // compare-and-delete); a request without it can't burn the login.
      const pending = secret ? await login.hub.pending.takeIfSecret(uid, secret) : null;
      if (!pending) {
        log.warn("interaction.completion_refused", {
          uid,
          reason: secret ? "completion_secret" : "no_completion_cookie",
        });
        sendHtml(
          ctx,
          400,
          errorPage({ message: "This sign-in can't be completed in this browser.", code: "browser_mismatch" }),
        );
        return;
      }
      let details;
      try {
        details = await provider.interactionDetails(ctx.req, ctx.res);
      } catch {
        details = null;
      }
      if (!details || details.uid !== uid) {
        log.warn("interaction.completion_refused", { uid, reason: "interaction_cookie" });
        sendHtml(
          ctx,
          400,
          errorPage({ message: "This sign-in can't be completed in this browser.", code: "browser_mismatch" }),
        );
        return;
      }
      log.info("interaction.login", { uid });
      await provider.interactionFinished(
        ctx.req,
        ctx.res,
        { login: { accountId: pending.sub } },
        { mergeWithLastSubmission: false },
      );
      ctx.respond = false;
      return;
    }

    // The Admin console's read of the sign-in trail (JSON, Bearer ID token), before the /admin… pages.
    if (deps.auditApi && path.startsWith("/admin/v1/") && (await deps.auditApi.handle(ctx as unknown as HttpContext)))
      return;

    // The local sign-in's own pages: /connect, /login…, /logout, /account…, /passkeys… and /admin….
    if (login.method === "local" && (await login.signIn.handle(ctx as unknown as HttpContext))) return;

    await next();

    // An app's sign-out (RP-initiated logout), confirmed with "Sign out": oidc-provider has ended its own session;
    // end the local sign-in's auth session too, or the next sign-in would be finished from it without asking.
    if (
      login.method === "local" &&
      path === "/session/end/confirm" &&
      ctx.method === "POST" &&
      ctx.status === 303 &&
      ctx.oidc?.params?.logout
    ) {
      await login.signIn.endAuthSession(ctx as unknown as HttpContext);
      log.info("logout.app", { clientId: ctx.oidc.client?.clientId ?? "" });
    }
  });

  return provider;
}

/**
 * Ends this browser's provider session, as RP-initiated logout's "Sign out" does: revokes the grants (and their
 * tokens) it holds, destroys it, and drops its cookie. For identity's own Sign out button (sign-in.ts).
 */
export async function endBrowserSession(provider: Provider, ctx: HttpContext): Promise<void> {
  const koa = ctx as unknown as Parameters<Provider["Session"]["get"]>[0];
  const session = await provider.Session.get(koa);
  for (const { grantId } of Object.values(session.authorizations ?? {})) {
    if (!grantId) continue;
    await Promise.all([
      provider.AccessToken.revokeByGrantId(grantId),
      provider.RefreshToken.revokeByGrantId(grantId),
      provider.AuthorizationCode.revokeByGrantId(grantId),
      provider.Grant.adapter.destroy(grantId),
    ]);
  }
  if (session.accountId) await session.destroy();
  ctx.cookies.set(provider.cookieName("session"), null, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: ctx.secure,
    signed: true,
    overwrite: true,
  });
}
