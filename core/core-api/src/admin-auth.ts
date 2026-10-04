/**
 * Who may call the admin API (P3.3b, ADR 0001 §4). Two callers:
 *
 *  - the CLI, with the static bearer token (`CORE_API_ADMIN_TOKEN`): the bootstrap and CI path.
 *    Audited as the actor "admin". It can be rotated, or switched off once the first admin exists.
 *  - a person, through the Admin console: the console is a pure OIDC client of core/identity, and
 *    passes the person's ID token (audience = the console's client id) as the bearer token. core-api
 *    verifies it against identity's published keys and then checks that `sub` holds `core.admin` in
 *    ITS OWN catalog, per request, so a revoked admin is refused at once. Audited as `user:<sub>`.
 *
 * Nothing here grants anything: `core.admin` is granted only by an admin (the CLI first).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { ApiError } from "./errors.ts";

export const CORE_ADMIN_ROLE = "core.admin";
const SUBJECT = /^[A-Za-z0-9._:@-]{1,128}$/;

/** Constant-time comparison of SHA-256 digests (same length), so neither content nor length leaks. */
export function bearerMatches(authorization: string | undefined, token: string): boolean {
  const got = /^Bearer (.+)$/.exec(authorization ?? "")?.[1] ?? "";
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(got), digest(token));
}

export interface IdentityVerifier {
  /** The verified `sub` of an ID token for the console's client, or throws (bad signature, expired, wrong audience…). */
  verify(idToken: string): Promise<string>;
}

export interface IdentityVerifierOptions {
  /** e.g. http://localhost:4010 (dev) or https://id.asafarim.site */
  issuer: string;
  /** The console's OIDC client id: tokens for any other client are refused. */
  audience: string;
  /** Tests give a local key set; production discovers identity's JWKS. */
  keys?: JWTVerifyGetKey;
  fetch?: typeof fetch;
}

export function createIdentityVerifier(opts: IdentityVerifierOptions): IdentityVerifier {
  const issuer = opts.issuer.replace(/\/$/, "");
  const doFetch = opts.fetch ?? fetch;
  let remote: JWTVerifyGetKey | undefined;

  /** Discover the JWKS once, from the issuer's own metadata, and only on the issuer's own origin. */
  async function keys(): Promise<JWTVerifyGetKey> {
    if (opts.keys) return opts.keys;
    if (!remote) {
      const res = await doFetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`identity discovery answered ${res.status}`);
      const { jwks_uri } = (await res.json()) as { jwks_uri?: string };
      const uri = new URL(jwks_uri ?? "");
      if (uri.origin !== new URL(issuer).origin) throw new Error("identity's jwks_uri isn't on the issuer's origin");
      remote = createRemoteJWKSet(uri, { cooldownDuration: 30_000 });
    }
    return remote;
  }

  return {
    async verify(idToken) {
      const { payload } = await jwtVerify(idToken, await keys(), {
        issuer,
        audience: opts.audience,
        // identity signs ES256 (core/identity IDENTITY_OIDC_JWKS): never "none", never HMAC with a public key.
        algorithms: ["ES256"],
        clockTolerance: 5,
      });
      if (typeof payload.sub !== "string" || !SUBJECT.test(payload.sub)) throw new Error("the token has no usable sub");
      return payload.sub;
    },
  };
}

export interface AdminCaller {
  /** What the audit log records: "admin" (the CLI token) or `user:<sub>`. */
  actor: string;
  kind: "cli" | "user";
  subject?: string;
}

export interface AdminAuthOptions {
  /** Undefined: the static token is switched off (CORE_API_ADMIN_TOKEN_DISABLED). */
  staticToken?: string;
  identity?: IdentityVerifier;
  /** Does `subject` hold `role` right now? (the database, per request) */
  holdsRole: (role: string, subject: string) => Promise<boolean>;
  log?: (line: object) => void;
}

export function createAdminAuth(opts: AdminAuthOptions) {
  return async function authorize(authorization: string | undefined): Promise<AdminCaller> {
    const bearer = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
    if (!bearer) throw new ApiError("unauthorized");
    if (opts.staticToken !== undefined && bearerMatches(authorization, opts.staticToken)) {
      return { actor: "admin", kind: "cli" };
    }
    // A JWT has exactly two dots; the static token is base64url and has none, so a wrong static token never reaches jose.
    if (opts.identity && bearer.split(".").length === 3) {
      let subject: string;
      try {
        subject = await opts.identity.verify(bearer);
      } catch (err) {
        opts.log?.({ msg: "admin.identity_token_refused", error: (err as Error).name });
        throw new ApiError("unauthorized", "the identity token isn't valid: sign in again");
      }
      if (!(await opts.holdsRole(CORE_ADMIN_ROLE, subject))) {
        opts.log?.({ msg: "admin.refused", reason: "not_admin" });
        throw new ApiError("forbidden", `needs the role ${CORE_ADMIN_ROLE}`);
      }
      return { actor: `user:${subject}`, kind: "user", subject };
    }
    throw new ApiError("unauthorized");
  };
}

export type AdminAuth = ReturnType<typeof createAdminAuth>;
