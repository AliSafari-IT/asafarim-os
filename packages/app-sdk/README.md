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

| Variable                           | What                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `ASAFARIM_APP_ID`                  | the app id (default: the manifest's `id`)                                                  |
| `ASAFARIM_REGISTRY_CREDENTIAL`     | `osk1.…`, the credential `platform app install` printed once                               |
| `CORE_API_URL`                     | where core-api is                                                                          |
| `ASAFARIM_ACCESS_TTL_MS`           | permission cache lifetime; default 60 000 (`pnpm dev` sets 1 000)                          |
| `APP_CONFIG_<KEY>`                 | overrides a manifest `config` key: `limits.maxNotes` → `APP_CONFIG_LIMITS_MAX_NOTES`       |
| `ASAFARIM_NATS_URL`                | the event bus for the outbox relay (`@asafarim/app-sdk/events`); unset = no relay          |
| `ASAFARIM_NATS_USER` / `_PASSWORD` | optional plain bus login (a bus without the auth callout, tests); wins over the credential |

Without a credential (not installed yet) `startApp` logs `app.not_installed` once and denies everything; it never throws at startup.

## Self-registration (`registerApp`, run by `startApp`)

POSTs the manifest to `core-api /registry/v1/apps/<id>`, signed with the credential (the protocol is in `@asafarim/registry-protocol`).

- **Retries** network errors and 5xx with exponential backoff (500 ms · 2ⁿ, capped at 15 s, up to 25% jitter), a **fresh signature and nonce each attempt**.
- **Stops at once on a 4xx** (a bad signature, an unknown app or a namespace violation won't fix itself).
- **Non-fatal** by default: it logs `app.registration_failed` and resolves `{ ok: false, error }`. With `strict: true` it throws `RegistrationError`.
- `platform.registered` resolves with `{ ok, attempts, state, version }` (plus `schemas`, below).

### Event schemas for the catalog (P4.2)

Pass the JSON Schemas of what the app publishes, keyed by the manifest's `events.publishes[].schema` path (the same map `createPublisher` takes):

```ts
startApp({ manifest, schemas: { "./events/notes.note.created.v1.json": noteCreated } });
```

After a successful registration the SDK resolves each published type's path and uploads `{ schemas: { <type>: <schema> } }` with a signed `PUT /registry/v1/apps/<id>/event-schemas`, with the same retry and backoff. The Admin event catalog shows them. A failed upload is logged (`app.event_schemas_failed`) and is **never fatal**, not even with `strict`; `platform.registered` then carries `schemas: { ok: false, attempts, error }`. Nothing is uploaded without `schemas`, when the app publishes nothing, or when registration failed. A published type whose path isn't in `schemas` stops the upload with `error: "missing_schema"`.

## Permission checks (`createAccess`)

The app asks core-api, with a signed `GET /registry/v1/apps/<id>/subjects/<sub>`, what a subject may do **in this app**: the roles an admin granted them and the permissions those carry. The token carries no permissions.

- `access(sub, { token? })` → `{ state, roles, permissions }`, cached for the TTL, and concurrent lookups share one request.
- `can(session, permission, { token? })` → boolean. No session, or core-api down → `false`.
- `require(session, permission, { token? })` → throws `ForbiddenError` (`.permission`, `.status = 403`).
- **With the person's access token** (below) the answer is the token's own and core-api isn't asked at all; without one, or with a bad one, or one for **another person**, it falls back to the signed lookup above.
- **Fails closed:** with core-api unreachable and no fresh answer, `access()` and `require()` throw `AccessUnavailableError`. A stale answer is never served.
- All SDK `fetch` calls use `cache: "no-store"`: Next.js caches GET `fetch` in development, which would otherwise answer for core-api.
- Use `isForbiddenError(err)` / `isAccessUnavailableError(err)` instead of `instanceof`: a framework can load this package twice (Next builds its instrumentation hook and each route separately).

`state` is the app's lifecycle state (`installed`, `active`, `inactive`). An app should answer 503 unless it's `active`.

## Events (P4.1): `@asafarim/app-sdk/events`

A separate entry point (it re-exports `@asafarim/events`), so pages that import the SDK never load the NATS client.

```ts
import { createPublisher, startAppRelay, OUTBOX_SQL } from "@asafarim/app-sdk/events";

const publisher = createPublisher({ manifest, schemas }); // schemas keyed by the manifest's events.publishes[].schema path
await client.query(OUTBOX_SQL); // the app's own migration (or @asafarim/events/sql/outbox.sql, or the Drizzle file)

await client.query("BEGIN");
const { rows } = await client.query("INSERT INTO notes … RETURNING *", […]);
await publisher.publish(client, "notes.note.created.v1", { … }, { subject: rows[0].id }); // same transaction
await client.query("COMMIT");

startAppRelay({ appId: manifest.id, pool }); // on boot: outbox → JetStream, Nats-Msg-Id = event id
```

- `publish` throws **before** writing for a type the manifest doesn't declare or a payload its JSON Schema refuses.
- The relay reads `ASAFARIM_NATS_URL`. Without it, it logs `events.relay.no_bus` once and the events wait in the outbox.
- Streams are created by core-api at install (`APP_<ID>` on `<id>.>`), never by the app.
- **The app's own identity on the bus (P4.1 PR 4).** The relay (and `subscribe`, pass `auth: busAuthFromEnv(appId)`) connects as user = the app id and password = a fresh, signed, single-use assertion made with `ASAFARIM_REGISTRY_CREDENTIAL` on every connect and reconnect. No second secret. The connection also sets `inboxPrefix: "_INBOX_<appId>"`: the app may subscribe to that inbox only. The bus (via core-api) grants only what the app's current manifest declares: publish `<id>.>`, pull and ack on its own durables, nothing else. Without a credential the connection is anonymous, which a bus with the callout refuses.

## The access token and the gateway (P3.3a)

Behind the OS gateway, core-api issues each signed-in person a short-lived **access token** (60 s by default) that the gateway and the SDK verify **locally**. See [core-api](../../core/core-api/README.md#the-gateway-and-the-access-token-p33a) for the model and the staleness trade-off. In an app:

- `access.mintToken(sub)`: the signed `POST` that asks core-api for the token (`503` for an inactive app → `AccessUnavailableError`).
- `createSessionHandler({ subject, mintToken })` → a `GET` handler for **`/api/asafarim/session`** (`ACCESS_SESSION_PATH`): signed in → sets the cookie (`accessCookie`) and goes back to `?next=` (same-site paths only: `safeNext` refuses `//evil`, `/\evil`, absolute URLs); not signed in → to sign-in with `callbackUrl`; core-api can't issue one → 503 (never a redirect back, which would loop through the gateway).
- `createTokenVerifier({ appId, coreApiUrl })`: verifies a token against core-api's JWKS (cached; one rate-limited refetch for an unknown key id; **fails closed**). `createAccess` uses it when you pass `{ token }`.
- `clearAccessCookie()`: on sign-out.
- In a Next.js app read the cookie with `cookies().get(ACCESS_COOKIE_NAME)` and pass it as `{ token }`: see `apps/notes/lib/gate.ts`.

**Auth.js behind a proxy:** a Next.js route handler sees its **own** origin in `request.url`, so Auth.js would send identity a `redirect_uri` for `http://localhost:4100` at the token exchange, while sign-in (a server action) used the visitor's host: identity answers `invalid_grant`. Wrap the Auth.js route handlers with `forwardedOrigin(...)` (`withForwardedOrigin` for one request) to restore the forwarded host and protocol; it accepts only a well-formed `x-forwarded-host` / `x-forwarded-proto`, which the gateway sets:

```ts
export const GET = forwardedOrigin(handlers.GET);
export const POST = forwardedOrigin(handlers.POST);
```

## The launcher (P3.3b)

The apps the signed-in person can open: **active** apps where they hold a role, plus public ones. core-api decides and supplies the tiles (names, glyphs, order: the same projection as the generated launcher registry); the SDK only asks.

```tsx
import { Launcher } from "@asafarim/app-sdk/react";

const apps = await platform.access.launcher(subject).catch(() => []); // never break the page
<Launcher apps={apps} current="notes" label="Your apps" />;
```

- `access.launcher(sub)`: a signed `GET`, cached for the access TTL, **fails closed** (`AccessUnavailableError`; a stale or malformed answer is never served).
- `<Launcher>` (from `@asafarim/app-sdk/react`; React is an optional peer): a labelled `<nav>` of links, `aria-current` on the current app, a visible focus style, light and dark, the host's tokens (`--card`, `--ink`, `--line`, `--accent`) when present, nothing for an empty list, and **http(s) links only**.

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
- `keepIdToken: true` keeps the ID token inside the encrypted session cookie (`token.idToken`) for an app that must present it on the person's behalf: the Admin console. It is **not** in the session object (that goes to the browser); read it on the server with `getToken`. `sessionMaxAgeSeconds` caps the session (the console uses the ID token's hour).

The app's OIDC client must exist in identity's client config (in development `pnpm dev:keys` writes one per app in `apps/*`).

## Develop

```bash
pnpm --filter @asafarim/app-sdk test
```
