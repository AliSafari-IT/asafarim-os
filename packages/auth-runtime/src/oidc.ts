/**
 * The OIDC client: discovery, authorization code flow with PKCE (S256), state and nonce, exact redirect URI, ID-token
 * validation, refresh, userinfo, RP-initiated logout URLs, and signed back-channel logout token validation.
 *
 * All protocol and crypto work is done by `openid-client` (and `jose` for the logout token). Nothing here implements a
 * signature check, a PKCE derivation or a JWT parser.
 */
import * as jose from "jose";
import * as client from "openid-client";
import {
  AuthorizationError,
  IdentityUnavailableError,
  InvalidConfigError,
  InvalidStateError,
  LogoutTokenInvalidError,
  ProviderRejectedError,
  TokenValidationError,
  type TokenValidationReason,
} from "./errors.ts";
import { endSessionUrl } from "./origin.ts";
import type { IdentityKey, ValidatedIdentity } from "./types.ts";

export const BACKCHANNEL_LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";

export interface OidcClientOptions {
  /** The issuer, exactly as the provider publishes it (for example `https://id.asafarim.site`). */
  issuer: string;
  clientId: string;
  /** Omit for a public client (PKCE only). */
  clientSecret?: string;
  /** Exact, configured. Never derived from a request. */
  redirectUri: string;
  /** Default `["openid", "email", "profile", "offline_access"]`. `offline_access` makes the provider issue a refresh token. */
  scope?: readonly string[];
  /** Expected ID token signature algorithm. Default `ES256` (what core/identity signs with). */
  idTokenSigningAlg?: string;
  /** Accepted logout token algorithms. Default `["ES256"]`. `none` and symmetric algorithms are always refused. */
  logoutTokenAlgorithms?: readonly string[];
  /** Back-channel logout tokens older than this are refused. Default 120 000. */
  logoutTokenMaxAgeMs?: number;
  /** Default `post_logout_redirect_uri` for the end-session URL. Must be registered with the provider. */
  postLogoutRedirectUri?: string;
  /** Per-request timeout towards the provider. Default 5 000. */
  timeoutMs?: number;
  /** Permit an `http:` issuer. Only for local development and tests; refused for any non-loopback host. */
  allowInsecureHttp?: boolean;
  /** Replace the HTTP transport (tests, proxies). Receives the same arguments as `fetch`. */
  fetch?: typeof fetch;
}

export interface AuthorizationRequest {
  state: string;
  nonce: string;
  codeChallenge: string;
  /** Seconds. Always sent, so the ID token carries `auth_time`. */
  maxAge?: number;
  prompt?: readonly ("none" | "login" | "consent" | "select_account")[];
  uiLocales?: string;
  /** App-chosen, allow-listed authorization parameters. The runtime does not invent provider parameters. */
  extra?: Readonly<Record<string, string>>;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Seconds. */
  expiresIn: number;
}

export interface UserinfoResult {
  sub: string;
  email?: string;
}

export interface LogoutTokenClaims {
  jti: string;
  /** Seconds. */
  iat: number;
  sid?: string;
  sub?: string;
}

export interface OidcClient {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  newPkce(): Promise<{ verifier: string; challenge: string }>;
  newState(): string;
  newNonce(): string;
  authorizationUrl(r: AuthorizationRequest): Promise<URL>;
  /** Exchange the code from the callback. `callbackUrl` must be the configured redirect URI plus the response parameters. */
  exchange(
    callbackUrl: URL,
    checks: { state: string; nonce: string; verifier: string; maxAge?: number },
  ): Promise<ValidatedIdentity>;
  refresh(refreshToken: string, expectedSub: string): Promise<TokenSet>;
  userinfo(accessToken: string, expectedSub: string): Promise<UserinfoResult>;
  /** The provider's end-session URL (discovery), else the conventional `<issuer>/session/end`. Never throws. */
  endSessionUrl(o?: { postLogoutRedirectUri?: string | null }): Promise<string>;
  validateLogoutToken(token: string): Promise<LogoutTokenClaims>;
}

const DEFAULT_SCOPE = ["openid", "email", "profile", "offline_access"] as const;
const FORBIDDEN_ALGS = new Set(["none", "HS256", "HS384", "HS512"]);
const MAX_TOKEN_LENGTH = 16 * 1024;

function isLoopback(u: URL): boolean {
  return (
    u.hostname === "localhost" ||
    u.hostname === "127.0.0.1" ||
    u.hostname === "[::1]" ||
    u.hostname.endsWith(".localhost")
  );
}

/** Duck-typed so the mapping does not depend on which package exports an error class. */
interface OauthErrorShape {
  name?: string;
  code?: string;
  status?: number;
  error?: string;
  cause?: { claim?: string; code?: string; status?: number; error?: string } | unknown;
}

function claimReason(e: OauthErrorShape): TokenValidationReason {
  const cause = (e.cause ?? {}) as { claim?: string };
  switch (cause.claim) {
    case "iss":
      return "issuer";
    case "aud":
    case "azp":
      return "audience";
    case "nonce":
      return "nonce";
    case "auth_time":
      return "auth_time";
    case "exp":
    case "iat":
    case "nbf":
      return "expired";
    default:
      return "claims";
  }
}

/** Map anything the library throws to a typed error without carrying its message (which can contain request data). */
export function mapProviderError(err: unknown): Error {
  const e = (err ?? {}) as OauthErrorShape;
  if (e.name === "AuthorizationResponseError") return new AuthorizationError(safeOauthCode(e.error));
  if (e.name === "ResponseBodyError") {
    const status = typeof e.status === "number" ? e.status : 0;
    if (status >= 500 || status === 0) return new IdentityUnavailableError();
    if (e.error === "invalid_grant") return new ProviderRejectedError("invalid_grant");
    if (e.error === "invalid_client") return new ProviderRejectedError("client_rejected");
    return new ProviderRejectedError("invalid_token");
  }
  if (e.name === "WWWAuthenticateChallengeError") return new ProviderRejectedError("invalid_token");
  const code = e.code ?? "";
  if (code === "OAUTH_JWT_TIMESTAMP_CHECK_FAILED") return new TokenValidationError("expired");
  if (code === "OAUTH_JWT_CLAIM_COMPARISON_FAILED") return new TokenValidationError(claimReason(e));
  if (
    code === "OAUTH_JWT_VALIDATION_FAILED" ||
    code === "OAUTH_JWKS_ERROR" ||
    code === "OAUTH_SIGNATURE_VERIFICATION_FAILED"
  )
    return new TokenValidationError("signature");
  if (code === "OAUTH_UNSUPPORTED_OPERATION" || code === "OAUTH_JWT_ALG_NOT_ALLOWED")
    return new TokenValidationError("alg");
  if (
    code === "OAUTH_PARAMETER_MISSING" ||
    code === "OAUTH_INVALID_RESPONSE" ||
    code === "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED"
  )
    return new TokenValidationError("claims");
  if (e.name === "AbortError" || e.name === "TimeoutError" || err instanceof TypeError)
    return new IdentityUnavailableError();
  // Unknown: a transport problem is more likely than a protocol one when nothing else matched.
  return new IdentityUnavailableError();
}

const OAUTH_ERROR_CODES = new Set([
  "access_denied",
  "login_required",
  "consent_required",
  "interaction_required",
  "account_selection_required",
  "invalid_request",
  "unauthorized_client",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
]);
function safeOauthCode(code: unknown): string {
  return typeof code === "string" && OAUTH_ERROR_CODES.has(code) ? code : "provider_error";
}

export function createOidcClient(opts: OidcClientOptions): OidcClient {
  let issuerUrl: URL;
  let redirect: URL;
  try {
    issuerUrl = new URL(opts.issuer);
    redirect = new URL(opts.redirectUri);
  } catch {
    throw new InvalidConfigError("issuer and redirectUri must be absolute URLs");
  }
  if (!opts.clientId) throw new InvalidConfigError("clientId is required");
  for (const [label, u] of [
    ["issuer", issuerUrl],
    ["redirectUri", redirect],
  ] as const) {
    if (u.username || u.password) throw new InvalidConfigError(`${label} must not contain credentials`);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && opts.allowInsecureHttp && isLoopback(u)))
      throw new InvalidConfigError(`${label} must be https (http only for loopback with allowInsecureHttp)`);
  }
  if (redirect.search || redirect.hash) throw new InvalidConfigError("redirectUri must not carry a query or fragment");
  const issuer = opts.issuer.replace(/\/$/, "");
  const scope = [...(opts.scope ?? DEFAULT_SCOPE)];
  if (!scope.includes("openid")) throw new InvalidConfigError("scope must include openid");
  const idTokenAlg = opts.idTokenSigningAlg ?? "ES256";
  const logoutAlgs = [...(opts.logoutTokenAlgorithms ?? ["ES256"])];
  if (logoutAlgs.length === 0 || logoutAlgs.some((a) => FORBIDDEN_ALGS.has(a)))
    throw new InvalidConfigError("logoutTokenAlgorithms must be asymmetric");
  const timeoutMs = opts.timeoutMs ?? 5000;
  const logoutMaxAgeSec = Math.ceil((opts.logoutTokenMaxAgeMs ?? 120_000) / 1000);

  const customFetch = opts.fetch
    ? (url: string, o: client.CustomFetchOptions) =>
        opts.fetch!(url, {
          method: o.method,
          headers: o.headers,
          body: o.body as unknown as RequestInit["body"],
          redirect: o.redirect,
          signal: o.signal,
        } as RequestInit)
    : undefined;

  let cached: { config: client.Configuration; at: number } | undefined;
  let inflight: Promise<client.Configuration> | undefined;
  let jwks: ReturnType<typeof jose.createRemoteJWKSet> | undefined;

  async function configuration(): Promise<client.Configuration> {
    if (cached && Date.now() - cached.at < 3600_000) return cached.config;
    inflight ??= (async () => {
      try {
        const config = await client.discovery(
          issuerUrl,
          opts.clientId,
          { id_token_signed_response_alg: idTokenAlg },
          opts.clientSecret ? client.ClientSecretBasic(opts.clientSecret) : client.None(),
          {
            timeout: Math.ceil(timeoutMs / 1000),
            ...(opts.allowInsecureHttp ? { execute: [client.allowInsecureRequests] } : {}),
            ...(customFetch ? { [client.customFetch]: customFetch } : {}),
          },
        );
        cached = { config, at: Date.now() };
        jwks = undefined;
        return config;
      } catch (err) {
        throw mapProviderError(err);
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  }

  const stringClaim = (v: unknown, max = 256): string | undefined =>
    typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;

  return {
    issuer,
    clientId: opts.clientId,
    redirectUri: redirect.href,

    async newPkce() {
      const verifier = client.randomPKCECodeVerifier();
      return { verifier, challenge: await client.calculatePKCECodeChallenge(verifier) };
    },
    newState: () => client.randomState(),
    newNonce: () => client.randomNonce(),

    async authorizationUrl(r) {
      const config = await configuration();
      const params: Record<string, string> = {
        ...r.extra,
        redirect_uri: redirect.href,
        scope: scope.join(" "),
        response_type: "code",
        state: r.state,
        nonce: r.nonce,
        code_challenge: r.codeChallenge,
        code_challenge_method: "S256",
      };
      if (r.maxAge !== undefined) params.max_age = String(Math.max(0, Math.floor(r.maxAge)));
      const prompt = new Set(r.prompt ?? []);
      // The provider only issues a refresh token when consent was part of the request.
      if (scope.includes("offline_access") && !prompt.has("none")) prompt.add("consent");
      if (prompt.size) params.prompt = [...prompt].join(" ");
      if (r.uiLocales) params.ui_locales = r.uiLocales;
      return client.buildAuthorizationUrl(config, params);
    },

    async exchange(callbackUrl, checks) {
      if (callbackUrl.origin + callbackUrl.pathname !== redirect.origin + redirect.pathname)
        throw new InvalidStateError("bad_callback");
      const states = callbackUrl.searchParams.getAll("state");
      if (states.length !== 1 || states[0] !== checks.state) throw new InvalidStateError("state_mismatch");
      const config = await configuration();
      let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
      try {
        tokens = await client.authorizationCodeGrant(config, callbackUrl, {
          expectedState: checks.state,
          expectedNonce: checks.nonce,
          pkceCodeVerifier: checks.verifier,
          idTokenExpected: true,
          ...(checks.maxAge !== undefined ? { maxAge: checks.maxAge } : {}),
        });
      } catch (err) {
        throw mapProviderError(err);
      }
      const claims = tokens.claims();
      const sub = stringClaim(claims?.sub);
      const iss = stringClaim(claims?.iss, 2048);
      const accessToken = stringClaim(tokens.access_token, MAX_TOKEN_LENGTH);
      if (!claims || !sub || !iss || !accessToken) throw new TokenValidationError("claims");
      if (iss !== issuer) throw new TokenValidationError("issuer");
      const authTime =
        typeof claims.auth_time === "number" && Number.isFinite(claims.auth_time) ? claims.auth_time : undefined;
      if (authTime === undefined) throw new TokenValidationError("auth_time");
      const sid = stringClaim(claims.sid);
      const amr = Array.isArray(claims.amr)
        ? claims.amr.filter((x): x is string => typeof x === "string").slice(0, 16)
        : undefined;
      const acr = stringClaim(claims.acr);
      const email = stringClaim(claims.email, 320);
      const refreshToken = stringClaim(tokens.refresh_token, MAX_TOKEN_LENGTH);
      const expiresIn = typeof tokens.expires_in === "number" && tokens.expires_in > 0 ? tokens.expires_in : 0;
      if (!expiresIn) throw new TokenValidationError("claims");
      const identityKey: IdentityKey = { iss, sub };
      return {
        identityKey,
        ...(sid ? { sid } : {}),
        authTime,
        issuedAt: typeof claims.iat === "number" ? claims.iat : Math.floor(Date.now() / 1000),
        ...(amr ? { amr } : {}),
        ...(acr ? { acr } : {}),
        ...(email ? { emailHint: email } : {}),
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        expiresIn,
      };
    },

    async refresh(refreshToken, expectedSub) {
      const config = await configuration();
      try {
        const t = await client.refreshTokenGrant(config, refreshToken);
        const accessToken = stringClaim(t.access_token, MAX_TOKEN_LENGTH);
        const next = t.refresh_token === undefined ? undefined : stringClaim(t.refresh_token, MAX_TOKEN_LENGTH);
        if (!accessToken || (t.refresh_token !== undefined && !next)) throw new TokenValidationError("claims");
        if (typeof t.expires_in !== "number" || !(t.expires_in > 0)) throw new TokenValidationError("claims");
        const idClaims = t.claims();
        if (idClaims && idClaims.sub !== expectedSub) throw new ProviderRejectedError("subject_mismatch");
        return { accessToken, ...(next ? { refreshToken: next } : {}), expiresIn: t.expires_in };
      } catch (err) {
        if (err instanceof TokenValidationError || err instanceof ProviderRejectedError) throw err;
        throw mapProviderError(err);
      }
    },

    async userinfo(accessToken, expectedSub) {
      const config = await configuration();
      try {
        const info = await client.fetchUserInfo(config, accessToken, expectedSub);
        const email = stringClaim(info.email, 320);
        return { sub: info.sub, ...(email ? { email } : {}) };
      } catch (err) {
        const e = err as OauthErrorShape;
        // A different subject is the provider telling us this is not the same person.
        if (e?.code === "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED") throw new ProviderRejectedError("subject_mismatch");
        throw mapProviderError(err);
      }
    },

    async endSessionUrl(o) {
      const post = o?.postLogoutRedirectUri ?? opts.postLogoutRedirectUri ?? null;
      try {
        const config = await configuration();
        const params: Record<string, string> = { client_id: opts.clientId };
        if (post) params.post_logout_redirect_uri = post;
        return client.buildEndSessionUrl(config, params).href;
      } catch {
        return endSessionUrl({ issuer, clientId: opts.clientId, postLogoutRedirectUri: post });
      }
    },

    async validateLogoutToken(token) {
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH)
        throw new LogoutTokenInvalidError();
      try {
        const config = await configuration();
        const uri = config.serverMetadata().jwks_uri;
        if (!uri) throw new LogoutTokenInvalidError();
        jwks ??= jose.createRemoteJWKSet(new URL(uri), {
          timeoutDuration: timeoutMs,
          ...(customFetch ? { [jose.customFetch]: (url: string, o: RequestInit) => opts.fetch!(url, o) } : {}),
        });
        const { payload } = await jose.jwtVerify(token, jwks, {
          issuer,
          audience: opts.clientId,
          algorithms: logoutAlgs,
          maxTokenAge: logoutMaxAgeSec,
          clockTolerance: 5,
          requiredClaims: ["iat", "jti", "events"],
        });
        // OIDC Back-Channel Logout 1.0 §2.6.
        if ("nonce" in payload) throw new LogoutTokenInvalidError();
        const events = payload.events as Record<string, unknown> | undefined;
        if (!events || typeof events !== "object" || Array.isArray(events)) throw new LogoutTokenInvalidError();
        const ev = events[BACKCHANNEL_LOGOUT_EVENT];
        if (!ev || typeof ev !== "object" || Array.isArray(ev)) throw new LogoutTokenInvalidError();
        const jti = stringClaim(payload.jti, 400);
        const sid = payload.sid === undefined ? undefined : stringClaim(payload.sid);
        const sub = payload.sub === undefined ? undefined : stringClaim(payload.sub);
        if (!jti || typeof payload.iat !== "number") throw new LogoutTokenInvalidError();
        if (payload.sid !== undefined && !sid) throw new LogoutTokenInvalidError();
        if (payload.sub !== undefined && !sub) throw new LogoutTokenInvalidError();
        if (!sid && !sub) throw new LogoutTokenInvalidError();
        return { jti, iat: payload.iat, ...(sid ? { sid } : {}), ...(sub ? { sub } : {}) };
      } catch (err) {
        // An outage fetching the key set is not "invalid token": the sender may retry. Everything else is.
        if (err instanceof IdentityUnavailableError) throw err;
        const code = (err as { code?: unknown } | null)?.code;
        if (typeof code !== "string" || code === "ERR_JWKS_TIMEOUT") throw new IdentityUnavailableError();
        throw new LogoutTokenInvalidError();
      }
    },
  };
}
