/**
 * The OIDC provider (panva/oidc-provider) for id.asafarim.site, with login
 * delegated to Hub (ADR 0002, Addendum A).
 *
 * Policy: authorization code flow only, PKCE (S256) required for every client,
 * ID tokens ES256, access tokens 10 min, refresh tokens only with
 * `offline_access` and rotated on every use, RP-initiated + back-channel logout.
 */
import { randomBytes } from "node:crypto";
import Provider, { type Configuration } from "oidc-provider";
import type { CryptoKey, JWK, KeyObject } from "jose";
import type { AccountStore } from "./accounts.ts";
import type { OidcClient } from "./clients.ts";
import { HandoffError, issueTicket, verifyAssertion, type ReplayGuard } from "./handoff.ts";
import type { Logger } from "./log.ts";
import { CONTINUE_PAGE_CSP, continuePage, errorPage, loggedOutPage, logoutPage } from "./pages.ts";
import { PENDING_TTL_SECONDS, hashSecret, type PendingLogins } from "./pending.ts";

export const ACCESS_TOKEN_TTL = 600;
export const SCOPES = ["openid", "offline_access", "email", "profile", "roles"];

export interface ProviderDeps {
  issuer: string;
  jwks: { keys: JWK[] };
  cookieKeys: string[];
  clients: OidcClient[];
  handoffPrivateKey: CryptoKey | KeyObject;
  hubPublicKey: CryptoKey | KeyObject;
  hubContinueUrl: string;
  trustProxy: boolean;
  // oidc-provider's adapter contract is a constructor taking the model name.
  adapter: Configuration["adapter"];
  accounts: AccountStore;
  replay: ReplayGuard;
  /** Verified logins waiting for /interaction/:uid/complete in the starting browser. */
  pending: PendingLogins;
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

const MAX_FORM_BYTES = 16 * 1024;

/** The completion cookie, scoped to one interaction's /complete path. */
const COMPLETION_COOKIE = "identity_complete";
const completePath = (uid: string) => `/interaction/${uid}/complete`;

/** The slice of a Koa context the helpers below use. */
interface HttpContext {
  status: number;
  type: string;
  body: unknown;
  req: AsyncIterable<unknown>;
  is(type: string): string | false | null;
  set(field: string, value: string): void;
}

async function readForm(ctx: HttpContext): Promise<URLSearchParams | null> {
  if (!ctx.is("application/x-www-form-urlencoded")) return null;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of ctx.req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function sendHtml(ctx: HttpContext, status: number, html: string) {
  ctx.status = status;
  ctx.type = "html";
  ctx.set("Cache-Control", "no-store");
  ctx.body = html;
}

export function createProvider(deps: ProviderDeps): Provider {
  const { log } = deps;

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
      const ticket = await issueTicket(uid, deps.handoffPrivateKey);
      const target = new URL(deps.hubContinueUrl);
      target.searchParams.set("ticket", ticket);
      log.info("interaction.handoff", { uid, clientId: String(details.params.client_id ?? "") });
      ctx.set("Cache-Control", "no-store");
      ctx.redirect(target.href);
      return;
    }

    // POST /interaction/:uid/hub — Hub's signed assertion comes back.
    const back = /^\/interaction\/([\w-]+)\/hub$/.exec(path);
    if (back && ctx.method === "POST") {
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
        ({ sub } = await verifyAssertion(assertion, { hubPublicKey: deps.hubPublicKey, uid, replay: deps.replay }));
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
      await deps.pending.put(uid, { sub, completionHash: hashSecret(secret) }, PENDING_TTL_SECONDS);
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
    if (complete && ctx.method === "GET") {
      const uid = complete[1]!;
      ctx.set("Cache-Control", "no-store");
      const secret = ctx.cookies.get(COMPLETION_COOKIE, { signed: false });
      ctx.cookies.set(COMPLETION_COOKIE, null, { path: completePath(uid), signed: false });
      // Consumed only when this browser holds the matching secret (atomic
      // compare-and-delete); a request without it can't burn the login.
      const pending = secret ? await deps.pending.takeIfSecret(uid, secret) : null;
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

    await next();
  });

  return provider;
}
