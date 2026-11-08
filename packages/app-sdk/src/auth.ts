/**
 * Sign-in helpers for apps that use Auth.js (next-auth v5) with core/identity: the configuration, the session cookie
 * name, the session lifetime and the forwarded-origin / end-session helpers.
 *
 * The implementation lives in `@asafarim/auth-runtime/authjs` (S2, #344), where it is shared with the plain Node adapter.
 * This module re-exports it under the same names with identical behaviour, so Notes, Docs, Admin and Flow need no change.
 * Pinned by `test/auth-golden.test.ts`, whose fixtures were captured before the move.
 */
export {
  asafarimAuthConfig,
  endSessionUrl,
  forwardedOrigin,
  IDENTITY_SESSION_SECONDS,
  SESSION_COOKIE_NAME,
  visitorOrigin,
  withForwardedOrigin,
  type AuthConfigOptions,
} from "@asafarim/auth-runtime/authjs";
