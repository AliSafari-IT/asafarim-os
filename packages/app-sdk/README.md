# @asafarim/app-sdk

What an ASafariM OS app needs from the platform (P3.2): register itself with core-api, check what a person may do, read its typed config and sign people in through `core/identity`. `apps/notes` is the reference user.

```ts
import { startApp } from "@asafarim/app-sdk";
import manifest from "./platform.app";

const platform = startApp({ manifest }); // on boot (Next.js: instrumentation.ts)

await platform.access.require(session, "notes.write"); // throws ForbiddenError naming the permission
platform.config.getInt("limits.maxNotes"); // typed, from the manifest
```

## What it reads from the environment

| Variable                       | What                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `ASAFARIM_APP_ID`              | the app id (default: the manifest's `id`)                                            |
| `ASAFARIM_REGISTRY_CREDENTIAL` | `osk1.…`, the credential `platform app install` printed once                         |
| `CORE_API_URL`                 | where core-api is                                                                    |
| `ASAFARIM_ACCESS_TTL_MS`       | permission cache lifetime; default 60 000 (`pnpm dev` sets 1 000)                    |
| `APP_CONFIG_<KEY>`             | overrides a manifest `config` key: `limits.maxNotes` → `APP_CONFIG_LIMITS_MAX_NOTES` |

Without a credential (not installed yet) `startApp` logs `app.not_installed` once and denies everything; it never throws at startup.

## Self-registration (`registerApp`, run by `startApp`)

POSTs the manifest to `core-api /registry/v1/apps/<id>`, signed with the credential (the protocol is in `@asafarim/registry-protocol`).

- **Retries** network errors and 5xx with exponential backoff (500 ms · 2ⁿ, capped at 15 s, up to 25% jitter), a **fresh signature and nonce each attempt**.
- **Stops at once on a 4xx** (a bad signature, an unknown app or a namespace violation won't fix itself).
- **Non-fatal** by default: it logs `app.registration_failed` and resolves `{ ok: false, error }`. With `strict: true` it throws `RegistrationError`.
- `platform.registered` resolves with `{ ok, attempts, state, version }`.

## Permission checks (`createAccess`)

The app asks core-api, with a signed `GET /registry/v1/apps/<id>/subjects/<sub>`, what a subject may do **in this app**: the roles an admin granted them and the permissions those carry. The token carries no permissions.

- `access(sub)` → `{ state, roles, permissions }`, cached for the TTL, and concurrent lookups share one request.
- `can(session, permission)` → boolean. No session, or core-api down → `false`.
- `require(session, permission)` → throws `ForbiddenError` (`.permission`, `.status = 403`).
- **Fails closed:** with core-api unreachable and no fresh answer, `access()` and `require()` throw `AccessUnavailableError`. A stale answer is never served.
- All SDK `fetch` calls use `cache: "no-store"`: Next.js caches GET `fetch` in development, which would otherwise answer for core-api.
- Use `isForbiddenError(err)` / `isAccessUnavailableError(err)` instead of `instanceof`: a framework can load this package twice (Next builds its instrumentation hook and each route separately).

`state` is the app's lifecycle state (`installed`, `active`, `inactive`). An app should answer 503 unless it's `active`.

## Typed config (`createConfig`)

Reads the manifest's `config` block: each key has a type and a default. `getString`, `getInt`, `getNumber`, `getBoolean` check the declared type; an undeclared key, the wrong type or a malformed override throws (at startup for overrides).

## Sign-in (`asafarimAuthConfig`)

An [Auth.js](https://authjs.dev) (next-auth v5) config for `core/identity`; the SDK doesn't depend on next-auth:

```ts
export const { handlers, auth, signIn, signOut } = NextAuth(
  asafarimAuthConfig({ issuer: process.env.OIDC_ISSUER!, clientId: "notes", secret: process.env.AUTH_SECRET }),
);
```

- Authorization code + **PKCE (S256)** + state + nonce, scopes `openid email profile roles`; a public client unless you pass `clientSecret`.
- The session is a JWT in a **host-only `__Host-` cookie**: `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`, so another app or subdomain can't read it. (Browsers accept `Secure` cookies on `http://localhost`, so it works in development.)
- `session.user.id` is the identity `sub`: the subject permissions are resolved for.

The app's OIDC client must exist in identity's client config (in development `pnpm dev:keys` writes one per app in `apps/*`).

## Develop

```bash
pnpm --filter @asafarim/app-sdk test
```
