import type { OidcClient, TokenSet } from "../src/oidc.ts";
import type { SessionRuntime } from "../src/session.ts";
import {
  IdentityUnavailableError,
  InvalidStateError,
  LogoutTokenInvalidError,
  ProviderRejectedError,
} from "../src/errors.ts";
import type { SessionBounds, ValidatedIdentity } from "../src/types.ts";

export const ORIGIN = "https://app.example";
export const ISSUER = "https://id.example";
export const CLIENT_ID = "test-app";

export const BOUNDS: SessionBounds = {
  absoluteMs: 12 * 3600_000,
  idleMs: 30 * 60_000,
  freshMs: 5 * 60_000,
  revalidateMs: 60_000,
  refreshSkewMs: 10_000,
  refreshLeaseMs: 30_000,
};

/** A controllable clock (milliseconds). */
export function clock(start = Date.UTC(2026, 10, 7, 10, 0, 0)) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    set(v: number) {
      t = v;
    },
  };
}

export type ProviderMode = "ok" | "reject" | "down";

/**
 * A fake OIDC client: UNIT-TEST ONLY. It records calls and lets a test decide how the "provider" answers. Anything that
 * claims to be end-to-end must use the real provider suite in core/identity/test/auth-runtime.integration.test.ts.
 */
export function fakeOidc(
  c: ReturnType<typeof clock>,
  init: Partial<{ expiresIn: number; withRefresh: boolean; sub: string; authAgeSec: number }> = {},
) {
  const state = {
    userinfo: "ok" as ProviderMode,
    refresh: "ok" as ProviderMode,
    refreshDelayMs: 0,
    refreshCalls: 0,
    userinfoCalls: 0,
    exchangeCalls: 0,
    expiresIn: init.expiresIn ?? 600,
    withRefresh: init.withRefresh ?? true,
    sub: init.sub ?? "subject-1",
    authAgeSec: init.authAgeSec ?? 0,
    issued: [] as string[],
    counter: 0,
    lastAuthorizationUrl: undefined as URL | undefined,
    logoutToken: undefined as undefined | { jti: string; iat: number; sid?: string; sub?: string },
    endSession: `${ISSUER}/session/end?client_id=${CLIENT_ID}`,
  };
  const token = (kind: string) => {
    const v = `${kind}-${++state.counter}-${"x".repeat(12)}`;
    state.issued.push(v);
    return v;
  };
  const client: OidcClient = {
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: `${ORIGIN}/auth/callback`,
    async newPkce() {
      return { verifier: "v".repeat(43), challenge: "c".repeat(43) };
    },
    newState: () => `state-${++state.counter}`,
    newNonce: () => `nonce-${++state.counter}`,
    async authorizationUrl(r) {
      const u = new URL(`${ISSUER}/auth`);
      u.searchParams.set("state", r.state);
      u.searchParams.set("nonce", r.nonce);
      if (r.maxAge !== undefined) u.searchParams.set("max_age", String(r.maxAge));
      if (r.prompt?.length) u.searchParams.set("prompt", r.prompt.join(" "));
      if (r.uiLocales) u.searchParams.set("ui_locales", r.uiLocales);
      for (const [k, v] of Object.entries(r.extra ?? {})) u.searchParams.set(k, v);
      state.lastAuthorizationUrl = u;
      return u;
    },
    async exchange(url, checks): Promise<ValidatedIdentity> {
      state.exchangeCalls++;
      if (url.searchParams.get("state") !== checks.state) throw new InvalidStateError("state_mismatch");
      if (url.searchParams.get("code") !== "good-code") throw new ProviderRejectedError("invalid_grant");
      const authTime = Math.floor(c.now() / 1000) - state.authAgeSec;
      return {
        identityKey: { iss: ISSUER, sub: state.sub },
        sid: "sid-1",
        authTime,
        issuedAt: Math.floor(c.now() / 1000),
        amr: ["otp"],
        acr: "1",
        emailHint: "person@example.test",
        accessToken: token("at"),
        ...(state.withRefresh ? { refreshToken: token("rt") } : {}),
        expiresIn: state.expiresIn,
      };
    },
    async refresh(_rt, sub): Promise<TokenSet> {
      state.refreshCalls++;
      if (state.refreshDelayMs) await new Promise((r) => setTimeout(r, state.refreshDelayMs));
      if (state.refresh === "down") throw new IdentityUnavailableError();
      if (state.refresh === "reject") throw new ProviderRejectedError("invalid_grant");
      if (sub !== state.sub) throw new ProviderRejectedError("subject_mismatch");
      return { accessToken: token("at"), refreshToken: token("rt"), expiresIn: state.expiresIn };
    },
    async userinfo(_at, sub) {
      state.userinfoCalls++;
      if (state.userinfo === "down") throw new IdentityUnavailableError();
      if (state.userinfo === "reject") throw new ProviderRejectedError("invalid_token");
      return { sub };
    },
    async endSessionUrl(o) {
      return o?.postLogoutRedirectUri
        ? `${state.endSession}&post_logout_redirect_uri=${encodeURIComponent(o.postLogoutRedirectUri)}`
        : state.endSession;
    },
    async validateLogoutToken(t) {
      if (t !== "valid-logout-token" || !state.logoutToken) throw new LogoutTokenInvalidError();
      return state.logoutToken;
    },
  };
  return { client, state };
}

/** Sign someone in through start() + callback() against the fake client. */
export async function signIn(runtime: SessionRuntime, o: Parameters<SessionRuntime["start"]>[0] = {}) {
  const started = await runtime.start(o);
  const state = new URL(started.redirect).searchParams.get("state")!;
  const result = await runtime.callback({
    query: new URLSearchParams({ code: "good-code", state }),
    flowId: started.flowId,
  });
  return { started, ...result };
}

/** Every string a test must never find in a response, a log line or an error. */
export function containsAny(haystack: string, needles: string[]): string | undefined {
  return needles.find((n) => n.length >= 8 && haystack.includes(n));
}
