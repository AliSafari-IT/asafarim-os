/**
 * The access token on the app side (P3.3a): verify it LOCALLY against
 * core-api's published keys, and the session endpoint that issues it as a
 * host-only cookie. See @asafarim/registry-protocol for the token itself.
 *
 * The cookie is what the gateway checks (forward_auth) and what `can()` /
 * `require()` use when given it, so the app and the gateway agree and share the
 * same staleness bound: a revoked grant is honoured for at most the token's
 * lifetime (60 s).
 */
import {
  ACCESS_COOKIE_NAME,
  ACCESS_SESSION_PATH,
  verifyAccessToken,
  type AccessClaims,
  type VerificationKey,
} from "@asafarim/registry-protocol";

export { ACCESS_COOKIE_NAME, ACCESS_SESSION_PATH };

export interface TokenVerifierOptions {
  appId: string;
  coreApiUrl: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** How long fetched keys are trusted before a refresh. Default 10 minutes. */
  jwksTtlMs?: number;
  /** The least time between two fetches triggered by an unknown key id. Default 30 s. */
  unknownKeyCooldownMs?: number;
}

/** Verifies access tokens for ONE app against core-api's JWKS (cached; fails closed). */
export function createTokenVerifier(opts: TokenVerifierOptions) {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  const ttl = opts.jwksTtlMs ?? 600_000;
  const cooldown = opts.unknownKeyCooldownMs ?? 30_000;
  const url = `${opts.coreApiUrl.replace(/\/$/, "")}/.well-known/jwks.json`;
  let keys: VerificationKey[] = [];
  let fetchedAt = 0;
  let inflight: Promise<void> | undefined;

  async function refresh(): Promise<void> {
    inflight ??= (async () => {
      try {
        // Not the framework's fetch cache: Next.js caches GETs in development.
        const res = await doFetch(url, { cache: "no-store", signal: AbortSignal.timeout(5000) });
        if (!res.ok) return;
        const doc = (await res.json()) as { keys?: { kid?: string; kty?: string; crv?: string; x?: string }[] };
        const fresh = (doc.keys ?? [])
          .filter((k) => k.kty === "OKP" && k.crv === "Ed25519" && k.kid && k.x)
          .map((k) => ({ kid: k.kid!, publicJwk: { kty: "OKP", crv: "Ed25519", x: k.x! } }));
        if (fresh.length > 0) keys = fresh;
      } catch {
        /* keep what we have: a failure never makes a token valid */
      } finally {
        fetchedAt = now().getTime();
        inflight = undefined;
      }
    })();
    return inflight;
  }

  /** The token's claims when it is genuine, for this app, and unexpired; otherwise undefined. */
  async function verify(token: string | undefined): Promise<AccessClaims | undefined> {
    if (!token) return undefined;
    if (keys.length === 0 || now().getTime() - fetchedAt >= ttl) await refresh();
    let result = verifyAccessToken(token, { keys, audience: opts.appId, now: now() });
    if (!result.ok && result.reason === "unknown_key" && now().getTime() - fetchedAt >= cooldown) {
      // A rotated key: look once (rate-limited), then decide.
      await refresh();
      result = verifyAccessToken(token, { keys, audience: opts.appId, now: now() });
    }
    return result.ok ? result.claims : undefined;
  }

  return { verify };
}

export type TokenVerifier = ReturnType<typeof createTokenVerifier>;

/** `Set-Cookie` value for the access token: host-only (no Domain), HttpOnly, Secure, SameSite=Lax. */
export function accessCookie(token: string, maxAgeSeconds: number): string {
  return `${ACCESS_COOKIE_NAME}=${token}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; HttpOnly; Secure; SameSite=Lax`;
}

/** `Set-Cookie` value that removes the access token (on sign-out). */
export function clearAccessCookie(): string {
  return `${ACCESS_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Only a same-site path may be returned to: it must start with a single "/",
 * so `//evil.example`, `/\evil.example` and absolute URLs fall back to "/".
 * The session endpoint itself is excluded so it can't redirect to itself.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || raw.length > 2048 || !/^\/(?![/\\])[^\r\n\\]*$/.test(raw)) return "/";
  if (raw === ACCESS_SESSION_PATH || raw.startsWith(`${ACCESS_SESSION_PATH}?`)) return "/";
  return raw;
}

export interface SessionHandlerOptions {
  /** The signed-in person's identity `sub` (from Auth.js `auth()`), or undefined. */
  subject: (request: Request) => Promise<string | undefined>;
  /** Issues the token: `platform.access.mintToken`. */
  mintToken: (subject: string) => Promise<{ token: string; expiresIn: number }>;
  /** Where a person who isn't signed in is sent (it gets `?callbackUrl=<next>`). Default Auth.js's `/api/auth/signin`. */
  signInPath?: string;
}

/**
 * The handler behind GET /api/asafarim/session (`ACCESS_SESSION_PATH`), which
 * the gateway sends a browser to when the token is missing or has expired:
 *
 *   signed in    → issue a fresh token cookie, then back to `?next=`
 *   not signed in → to the sign-in page, which returns to `next` afterwards
 *   core-api can't issue one → 503 (never back to `next`: that would loop)
 *
 * Plain Web `Request`/`Response`, so a Next.js route can export it as `GET`.
 */
export function createSessionHandler(opts: SessionHandlerOptions) {
  const signIn = opts.signInPath ?? "/api/auth/signin";
  return async function GET(request: Request): Promise<Response> {
    const next = safeNext(new URL(request.url).searchParams.get("next"));
    const subject = await opts.subject(request);
    if (!subject) {
      return new Response(null, {
        status: 302,
        headers: { location: `${signIn}?callbackUrl=${encodeURIComponent(next)}`, "cache-control": "no-store" },
      });
    }
    try {
      const { token, expiresIn } = await opts.mintToken(subject);
      const headers = new Headers({ location: next, "cache-control": "no-store" });
      headers.append("set-cookie", accessCookie(token, expiresIn));
      return new Response(null, { status: 302, headers });
    } catch {
      return new Response(
        JSON.stringify({ error: "token_unavailable", message: "Couldn't issue an access token right now." }),
        { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } },
      );
    }
  };
}
