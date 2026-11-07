# @asafarim/auth-runtime

A small, framework-independent OIDC client and server-side session runtime for ASafariM apps (S2 of the shared-identity programme, #339/#344). **Private at 0.1.0**: publishing is S3. It depends only on `openid-client` and `jose`; it has no React, no Auth.js, no `core/*` or `apps/*` import and no app id or issuer baked in.

It does the generic parts of "sign in with the ASafariM account" so an app does not copy them: discovery, authorization code flow with PKCE (S256), state, nonce and an exact redirect URI, ID-token validation, refresh, userinfo, RP-initiated logout and **signed back-channel logout validation**; and the session side: host-only cookie sessions, absolute and idle bounds, refresh locking with lease renewal, freshness (step-up), a bounded provider re-check and bounded outage behaviour. Domain grants, memberships, workspace rules and profile fields stay in the app, behind hooks.

## Subpaths

| Import                                 | What                                                                                                                                                            | Needs                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `@asafarim/auth-runtime`               | typed errors, `SessionBounds`/`resolveBounds`/`isFresh`, `validateReturnTarget`, cookie helpers, `endSessionUrl`, `visitorOrigin`, `withForwardedOrigin`, types | nothing                  |
| `@asafarim/auth-runtime/oidc`          | `createOidcClient`, `validateLogoutToken`                                                                                                                       | `openid-client`, `jose`  |
| `@asafarim/auth-runtime/session`       | `createSessionRuntime` (transport independent)                                                                                                                  | nothing                  |
| `@asafarim/auth-runtime/node`          | plain Node adapter: `createNodeAuth`, `createSessionStateHandler`                                                                                               | the two above            |
| `@asafarim/auth-runtime/authjs`        | `asafarimAuthConfig` and friends, **moved unchanged** from `@asafarim/app-sdk` (which re-exports them)                                                          | nothing (no `next-auth`) |
| `@asafarim/auth-runtime/stores/redis`  | `createRedisStore`: atomic Lua, keyed digests, encrypted records                                                                                                | an `eval`-capable client |
| `@asafarim/auth-runtime/stores/memory` | `createMemoryStore`: tests, development and one process                                                                                                         | nothing                  |

## The plain Node adapter

```ts
import { createServer } from "node:http";
import { createNodeAuth } from "@asafarim/auth-runtime/node";
import { createRedisStore } from "@asafarim/auth-runtime/stores/redis";

const store = createRedisStore({ redis, secret: process.env.SESSION_STORE_SECRET!, prefix: "myapp" });
const auth = createNodeAuth({
  issuer: "https://id.asafarim.site",
  clientId: "myapp",
  clientSecret: process.env.OIDC_CLIENT_SECRET, // omit for a public client
  origin: "https://myapp.asafarim.site", // exact; every URL the adapter builds comes from here
  store,
  flows: store,
  bounds: { absoluteMs: 12 * 3600_000, idleMs: 30 * 60_000, freshMs: 5 * 60_000, revalidateMs: 60_000 }, // required, no defaults
  policies: ["management"], // names your `authorize` hook decides
  hooks: {
    onSignIn: async (claims) => ({ allow: true }), // claims.identityKey = { iss, sub }; never tokens
    authorize: async (session, policy) => policy === "access" || myRules(session.identityKey, policy),
  },
});

createServer(async (req, res) => {
  if (await auth.handle(req, res)) return; // /auth/start, /callback, /logout, /logout/everywhere, /backchannel-logout, /session
  const session = await auth.require(req, { policy: "management", fresh: true });
  // …
}).listen(3000);
```

Routes (prefix `/auth`): `GET start?return=&fresh=1&intent=&locale=`, `GET callback`, `POST logout` (this app only), `POST logout/everywhere` (then the provider's end-session URL), `POST backchannel-logout`, `GET session` (minimal JSON). `createSessionStateHandler({ auth, allowedOrigins })` serves the same answer cross-origin to an exact allow-list for a public page's header.

## Rules the runtime enforces

- **Identity key is `(iss, sub)`.** Hooks receive `identityKey`; the e-mail is `emailHint`, informational only. Nothing looks up or links an account by e-mail.
- **Tokens stay on the server.** The cookie is an opaque 43-character id; tokens live in the store, encrypted. Errors carry a code and a closed reason, never a token, id, state, URL or message from the provider. `onSignIn`/`authorize` get claims, not tokens, unless `needsTokens: true`.
- **Return targets** are validated against the configured origin (and an exact allow-list) and kept in the server-side flow; the callback query cannot change them. `locale` and `intent` are allow-listed the same way.
- **Bounds are per app and required.** `absoluteMs` counts from `auth_time`; `idleMs` slides (or is `null`); `revalidateMs` is the longest a positive provider check is trusted; `freshMs` is the step-up window. `defaultBounds` is an example constant, never applied implicitly.
- **Step-up against core/identity:** a fresh sign-in sends `prompt=login` and `max_age=freshMs`, and the callback re-checks `auth_time` from the verified ID token (a browser's `?fresh=1` is only a request). core/identity answers `prompt=login` from its own session when that session is younger than 120 s, so keep `freshMs` at 120 s or more (Breinhap's 300 s is fine); a shorter window can find a recent-enough session that is still too old for the app and refuse the step-up in a loop.
- **Refresh:** one refresher per session (store lock with a renewed lease); the others wait for its result. A result is never saved after the lock was lost.
- **Outage:** inside `revalidateMs` the session is served from the last positive check; after it, or when a refresh is needed, the request is denied with `IdentityUnavailableError` and the session is **kept**. A store outage fails closed (`StoreUnavailableError`). Nothing falls back permissively.
- **Logout** has two labels: `logoutLocal` ends this app's session and never needs the provider; `logoutEverywhere` ends it first, then returns the provider URL.
- **Back-channel logout** tokens are validated (signature against the provider's keys, issuer, audience, `events`, no `nonce`, `jti`, age), replay-guarded by `jti`, and revoke by `sid`/`sub`. The provider (core/identity) makes one attempt and does not retry: a missed delivery ends the session at the next `revalidateMs` check.
- **Rate budgets (optional, recommended for anything on the internet).** `deps.budget(name, key)` returns false to refuse. The runtime asks `("start", requester)` and `("start-global", "global")` before `/auth/start` writes a flow (429, nothing written); give the adapter `requester(request)` from your trusted proxy, because it ignores forwarded headers and cannot know the client address itself. For back-channel logout it asks `("backchannel-logout-raw", "global")` before validating (give that a generous limit: it only caps unauthenticated garbage) and `("backchannel-logout", sid ?? sub)` after the token validated, so a flood of junk cannot starve the provider's real notifications. Without `deps.budget` nothing is limited.
- **Single sign-on and consent.** A sign-in sends no `prompt` unless asked, so an existing identity session gives a new app session with no credential step (proved against the real provider in test 4 / 8a). Because the default scope includes `offline_access`, the request also carries `prompt=consent`, which core/identity answers automatically for first-party apps (no screen). An app that only needs the header state and no refresh token can pass `scope: ["openid", "email", "profile"]` and sends no consent prompt at all (its session then ends with its access token).
- **Authorization policies** are evaluated on every `state()`/`require()`; there is no cache, so the header and a guarded route cannot disagree.

## The Auth.js adapter

`@asafarim/auth-runtime/authjs` is `asafarimAuthConfig`, `SESSION_COOKIE_NAME`, `IDENTITY_SESSION_SECONDS` and the forwarded-origin helpers exactly as they were in `@asafarim/app-sdk`, which now re-exports them under the same names. It gives Notes, Docs, Admin and Flow **no new guarantees**: a stateless Auth.js JWT session has no idle bound, no refresh lock, no back-channel logout and no step-up (asserted as documented gaps in `test/contract.test.ts`).

## Tests, and what each kind proves

- `test/*.test.ts` are **unit** tests: a fake provider client or a stub provider with real signatures (for tokens a real provider never emits), and the in-memory store. They prove the runtime's own logic.
- `test/redis-store.test.ts` runs the store contract against a **real Redis** (`IDENTITY_TEST_REDIS_URL`; under `CI` a missing variable is a failure).
- The real-provider evidence is `core/identity/test/auth-runtime.integration.test.ts`: `createProvider`, Postgres, Redis and HTTP, with the runtime's Node adapter as the app. Its header lists the few things that are not real (the mail transport, a passthrough fetch for loopback back-channel delivery, an injected clock).
- `test/packaging.test.ts` builds the package and checks what a consumer would get (no `workspace:`, no source paths, only `jose` and `openid-client` as external imports).

## Errors

All extend `AuthRuntimeError` (`code`, `status`, closed `reason`, explicit `toJSON`): `InvalidConfigError`, `InvalidStateError`, `InvalidReturnTargetError`, `TokenValidationError`, `LogoutTokenInvalidError`, `LogoutReplayError`, `SessionExpiredError`, `AuthenticationRequiredError`, `StepUpRequiredError`, `IdentityUnavailableError`, `ProviderRejectedError`, `AuthorizationError`, `StoreUnavailableError`, `StoreCorruptError`, `RefreshBusyError`, `RefreshOwnershipLostError`, `ProfileDeniedError`, `CsrfError`, `PayloadTooLargeError`, `RateLimitedError`.
