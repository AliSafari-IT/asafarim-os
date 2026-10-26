# core/identity

The ASafariM OS identity service: the **OpenID Connect provider** for `id.asafarim.site`. Apps on their own domains (first: Testora on `testora.cloud`) sign people in through it. How a person proves who they are is a **login method**, chosen by `IDENTITY_LOGIN_METHOD`:

- **`hub`** (the default): login stays in Hub. The provider hands the browser to Hub with a signed ticket, and Hub posts back a signed assertion ([Login hand-off](#login-hand-off-adr-0002-a2)). Design: ADR 0002 and its Addendum A (private docs, `ventures/asafarim-os/adr/0002-…`).
- **`local`**: the service's own sign-in with **email codes and passkeys** (SMS optional), with access granted by an admin ([Local sign-in](#local-sign-in)).

It runs [`oidc-provider`](https://github.com/panva/node-oidc-provider) (major version 9) on Node 24, which runs the TypeScript directly (no build step).

## What it enforces

| Policy            | Value                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Flows             | authorization code only (no implicit, no hybrid)                                                                                                                                                       |
| PKCE              | required for every client, `S256` only                                                                                                                                                                 |
| ID token          | `ES256`                                                                                                                                                                                                |
| Access token      | 10 min                                                                                                                                                                                                 |
| Refresh token     | only with `offline_access` (which needs `prompt=consent`), rotated on every use; reusing an old one fails                                                                                              |
| Logout            | RP-initiated logout, plus back-channel logout to every client in the session                                                                                                                           |
| Consent           | none shown: every client is a first-party ASafariM app; the grant covers exactly the scopes requested                                                                                                  |
| Accounts          | `hub`: the platform's `identity_accounts_v` view, read-only. `sms`: a principal with an **active connection** in the service's own database. Either way, an inactive or unknown account gets no tokens |
| Outbound requests | oidc-provider's SSRF guard stays on: back-channel logout never calls loopback or private addresses                                                                                                     |

Endpoints: discovery (`/.well-known/openid-configuration`), `/jwks`, `/auth`, `/token`, `/me` (userinfo), `/session/end`, `/token/revocation`, plus `/healthz` (live), `/readyz` (Redis and accounts DB) and `/favicon.svg`.

Every page the service renders shares one layout (`src/pages.ts`): a header whose brand goes back to the OS home (`IDENTITY_HOME_URL`, asafarim.site with the hub method), the favicon, and a footer, so no page is a dead end.

## Login hand-off (ADR 0002, A2)

1. A client starts the code flow at `/auth`. The provider creates an interaction (`uid`) and sends the browser to `/interaction/<uid>`.
2. The service signs a **ticket** (Ed25519, `iss=id`, `aud=hub`, `uid`, a nonce, `exp` ≤ 120 s) and redirects to `IDENTITY_HUB_CONTINUE_URL?ticket=…`.
3. Hub signs the person in (or reuses its session) and auto-POSTs an **assertion** to `/interaction/<uid>/hub` as the form field `assertion`. The assertion is an Ed25519 JWS with `iss=hub`, `aud=id`, `sub` (the platform user id), the same `uid`, `exp` ≤ 60 s and a single-use `jti`.
4. The service verifies it: the signature (with Hub's pinned key), the issuer, the audience, the lifetime, the `uid`, and that the `jti` hasn't been seen (Redis). The account must exist and be active.
5. It does **not** finish the login yet. Hub's POST is cross-site, so the browser doesn't send the provider's (SameSite=Lax) interaction cookie with it, and nothing proves the posting browser is the one that started the sign-in. Instead it **parks** the verified `sub` in Redis (keyed by `uid`, 60 s, single-use), sets a random **completion cookie** scoped to `/interaction/<uid>/complete` (only its SHA-256 is stored), and answers `200` with a page that navigates to that path. It must not redirect: Hub's assertion page has `form-action <issuer>`, and Chromium applies that to every redirect in the chain, so a redirect to the client's origin is blocked.
6. `GET /interaction/<uid>/complete` is a top-level GET, so the browser sends both cookies. It finishes the interaction with `accountId = sub` **only** if the completion cookie matches the parked login **and** the provider's interaction cookie is there (`interactionDetails` succeeds for this `uid`). That means the same browser started the sign-in and posted the assertion. Otherwise: `browser_mismatch`, and nothing is finished.

**Why both cookies:** if someone else's signed-in browser opens your continue link, it can post an assertion for _their_ account, but it doesn't hold your interaction cookie, so it can't finish your sign-in. Your browser holds the interaction cookie but never received the completion cookie, so it can't finish with their account either. Without this step, an interaction could be completed with a different person's account (asafarim-platform#723, review of #23).

Any failure shows a styled error page with a short code (`assertion_replayed`, `account_inactive`, `browser_mismatch`, …) and logs nothing that identifies the person; there is no partial login.

## Local sign-in

`IDENTITY_LOGIN_METHOD=local`, `IDENTITY_SIGN_IN_METHODS=email,passkey` (default; `google` and `sms` optional; the first version's `IDENTITY_LOGIN_METHOD=sms` still means SMS only). No third-party service or library is involved: codes are emailed by the service's own SMTP client (`src/smtp.ts`) through your mail server, and passkeys are verified by its own WebAuthn code (`src/webauthn.ts`, `src/cbor.ts`).

- **Email codes** work exactly like the SMS codes below (same storage, limits, single use, no probing), with `IDENTITY_SMTP_*` settings. TLS is always verified; `starttls` refuses a server that doesn't offer it; AUTH is only sent over TLS.
- **Passkeys:** a signed-in person adds one on **`/account`**; after that "Sign in with a passkey" on `/login` needs no code. The server checks the challenge (single use), the origin (`IDENTITY_ISSUER`), the rpId hash, user presence **and** verification, the signature (ES256, EdDSA, RS256 ≥ 2048 bits) and the sign counter. Attestation is `none`. The page's only script is `/static/passkey.js` (`script-src 'self'`).
- Passkeys alone can't be the only method: someone has to sign in once with a code to add the first one.

The flow with codes (the same for email and SMS):

**QR code or link → `/connect` → `/login` → mobile number → SMS code → verify → connected? → the app (or `IDENTITY_HOME_URL`)**. If the number isn't connected: **"Request connection" → an admin approves → sign in again**.

### Continue with Google

`google` in `IDENTITY_SIGN_IN_METHODS` puts **Continue with Google** first on `/login` (`src/google.ts`, no library besides jose). It is the OpenID Connect code flow with PKCE (S256), a `state` bound to this browser's login flow (single use, 10 minutes) and a `nonce` checked in the ID token; the token's signature (Google's JWKS), issuer, audience and expiry are verified. `/login/google` is a plain link, not a form, so `form-action 'self'` doesn't block the hop to Google.

- The identity is Google's account id (`sub`, method `google`), never the address. The verified address is kept for display (`identities.email`).
- A first Google sign-in joins the principal that already holds the address **only when Google is its authority**: an `@gmail.com` address, or a Workspace one (`hd` = the address's domain). A new Gmail address also becomes a verified email identity. Any other address gets a principal of its own, so a Google account can never take over an account it doesn't own.
- Like every method, it **grants nothing**: the principal still needs an admin's connection.

Settings: `IDENTITY_GOOGLE_CLIENT_ID` and `IDENTITY_GOOGLE_CLIENT_SECRET`, from a Google Cloud OAuth client of type _Web application_ whose authorized redirect URI is `https://id.asafarim.site/login/google/callback`. Audit events: `google.verified`, `google.failed` (`detail.reason`), and `method = google` on `login.granted` / `login.not_authorized`.

### Access requests

Someone signed in but not connected sees **Ask for access**: they pick the apps they need (the named clients) and may add a note (500 characters). The admins get an email (when email is configured); `/admin` shows who asked, how they sign in, the apps and the note. **Approve** connects the account and emails the requester; **Reject** emails them too. A connected person can ask for more apps from `/account`; approving that closes the request, and the admin grants the app roles in the Admin console (core-api decides who may open an app). One open request per person: asking again adds apps and replaces the note (`request.updated`). Reconnecting a revoked account works by principal, whatever way they sign in.

### Authentication and authorization are separate

- **Authentication**: the SMS code proves the person holds the number. It creates (on first proof) a _principal_ and an `identities` row (`method = 'phone'`). It grants nothing on its own.
- **Authorization**: the principal has an **active connection** (`connections`). It is read from the database on every use: when a sign-in finishes, in `findAccount` (so no code, token, refresh or userinfo for anyone not connected), and on every admin page. The browser is never trusted with it.
- **Other methods later** (email, passkeys, …) add rows to `identities` and their own routes. Connections, requests, the admin and the OIDC side don't change.

### The QR code

It is a plain URL, `https://id.asafarim.site/connect`, which is not secret and holds no credential. `/connect` only starts a sign-in. Make it with any QR generator. Different QR codes per place or device can later carry a signed, short-lived parameter without changing the flow.

### Codes and limits

| What               | Rule                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Code               | 6 random digits, valid 5 minutes, single use                                                                                         |
| Storage            | Redis holds an HMAC of (challenge, number, code) under `IDENTITY_OTP_SECRET`, never the code                                         |
| Wrong tries        | 5 per code, then the code is gone (checked, counted and deleted in one Redis step)                                                   |
| Sending            | 1 per number per minute; 3 per number per 15 min and 10 per day; 10 per IP per hour; `IDENTITY_SMS_DAILY_LIMIT` in all per day       |
| Verifying          | 30 per IP and 15 per number per hour                                                                                                 |
| Countries          | only numbers starting with `IDENTITY_SMS_ALLOWED_PREFIXES` (default `+32`) get an SMS                                                |
| No account probing | until the code is proved, every answer is the same whether the number is unknown, waiting or connected                               |
| Sessions           | after a correct code, a random cookie (`identity_auth`, HttpOnly, SameSite=Lax, Secure on https), 12 h; Redis keeps only its SHA-256 |
| Forms              | a CSRF token in every form; pages send `form-action 'self'`, `frame-ancestors 'none'`, no script                                     |

The client IP for limits is the **last** `X-Forwarded-For` entry (the one the edge Caddy adds). Rate-limit keys and audit entries use HMACs of numbers and IPs, never the values.

### Admin (`/admin`)

For a connected principal with `is_admin`, signed in by SMS (`/login?next=admin`):

- approve or reject pending requests (a request stays pending until someone decides);
- connect a number directly;
- revoke a connection, or reconnect a revoked one.

**Revoking takes effect at once**: the person's SMS sessions are deleted, their provider sessions end and their grants are revoked (codes, access and refresh tokens). Anything an app still holds is refused at its next token, refresh or userinfo call. An admin can't revoke themselves.

**The first admin** comes from `IDENTITY_BOOTSTRAP_ADMIN_PHONE`, in the encrypted env, never in git. At start, and only while **no admin has an active connection**, that number is made an admin with an active connection. Otherwise the variable does nothing, which also makes it the recovery path.

### Audit trail

`audit_log` is append-only: a trigger refuses `UPDATE`, `DELETE` and `TRUNCATE`. It records:

- codes sent, refused and failed;
- verifications and their failures;
- sign-ins granted and refused;
- connection requests;
- approvals, rejections, connections and revocations, each with the acting admin.

The admin page shows the latest 50 entries. The Admin console reads the whole trail, filtered, through a read-only JSON API (`src/audit-api.ts`):

| Endpoint                                                                               | What                                                                                                       |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /admin/v1/audit[?event=&method=&principal=&handle=&since=&until=&before=&limit=]` | newest first; `event` is up to 16 comma-separated events or kinds (`otp.`); `handle` an IP or subject HMAC |
| `GET /admin/v1/audit/summary[?days=14]`                                                | counts per UTC day and event, open requests, active connections                                            |

The caller sends the signed-in person's ID token as `Bearer`. It must be identity's own (ES256, this issuer), issued to a client in `IDENTITY_AUDIT_READERS` (default `core-admin`), unexpired, and its subject must be an identity admin with an active connection, read fresh. Anyone else gets 401 or 403, and a signed-in non-admin's attempt is audited as `admin.denied` (`via: audit_api`). The console has already checked `core.admin` with core-api, so a reader needs both. Rows carry each person's label (email, else phone) and the HMAC handles, never a code, a number or an address. Local sign-in only: with Hub login the paths are not served.

### Its database

`IDENTITY_DATABASE_URL` is a Postgres database the service owns. `migrations/*.sql` are applied at start, one at a time across replicas (advisory lock). It is a separate database from the platform's, so it isn't the read-only `identity_ro` login.

## Configuration (env)

| Variable                         | What                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `IDENTITY_ISSUER`                | `https://id.asafarim.site` (https required except on localhost)                                                            |
| `PORT`                           | default `3000`                                                                                                             |
| `IDENTITY_REDIS_URL`             | e.g. `redis://redis:6379/3`. A **dedicated logical DB**; keys use the `oidc:` prefix and carry the model's TTL             |
| `IDENTITY_ACCOUNTS_DATABASE_URL` | the platform DB as the `identity_ro` login role (SELECT on `identity_accounts_v` only). Sessions are also forced read-only |
| `IDENTITY_OIDC_JWKS`             | `{"keys":[…]}`: 1 private EC P-256 JWK with a `kid`, or 2 during a rotation. The **first** key signs                       |
| `IDENTITY_COOKIE_KEYS`           | comma-separated, each ≥ 32 characters; the first signs cookies, the rest still verify                                      |
| `IDENTITY_HANDOFF_PRIVATE_JWK`   | the service's Ed25519 private JWK (signs tickets)                                                                          |
| `IDENTITY_HUB_PUBLIC_JWK`        | Hub's Ed25519 **public** JWK (verifies assertions). A private key here is refused                                          |
| `IDENTITY_HUB_CONTINUE_URL`      | `https://hub.asafarim.com/oidc/continue`                                                                                   |
| `IDENTITY_CLIENTS_FILE`          | path to the client config (below)                                                                                          |
| `IDENTITY_CLIENT_SECRET_<APP>`   | each confidential client's secret (≥ 32 characters), named by the client config                                            |
| `IDENTITY_TRUST_PROXY`           | `true` by default (behind the edge Caddy); `false` when exposed directly                                                   |
| `IDENTITY_LOGIN_METHOD`          | `hub` (default) or `sms`. With `sms`, the Hub variables and `IDENTITY_ACCOUNTS_DATABASE_URL` aren't needed                 |

With `IDENTITY_LOGIN_METHOD=sms`:

| Variable                         | What                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `IDENTITY_DATABASE_URL`          | the service's own Postgres database (owner role); migrated at start                                                    |
| `IDENTITY_OTP_SECRET`            | ≥ 32 characters: the HMAC key for codes, rate-limit keys and audit handles. Changing it voids codes in flight only     |
| `IDENTITY_SMS_PROVIDER`          | `twilio` (default). `dev-log` writes codes to the service's stderr, and only with `NODE_ENV=development` on localhost  |
| `IDENTITY_TWILIO_ACCOUNT_SID`    | `AC…`                                                                                                                  |
| `IDENTITY_TWILIO_AUTH_TOKEN`     | the account's auth token (or an API key secret)                                                                        |
| `IDENTITY_TWILIO_FROM`           | a sender number (E.164), an alphanumeric sender id, or a Messaging Service SID (`MG…`)                                 |
| `IDENTITY_SMS_ALLOWED_PREFIXES`  | comma-separated, default `+32`                                                                                         |
| `IDENTITY_SMS_DAILY_LIMIT`       | default `200`: SMS per 24 h, all numbers together (a cost cap)                                                         |
| `IDENTITY_HOME_URL`              | where a sign-in that didn't come from an app goes (the QR code's destination); https, default `https://asafarim.site/` |
| `IDENTITY_BOOTSTRAP_ADMIN_PHONE` | optional: the first admin's number, used only while no admin is connected (above)                                      |
| `IDENTITY_ADMIN_CONSOLE_URL`     | optional: the Admin console, linked in an identity admin's header (it checks `core.admin` itself)                      |

All of these live in the deployment's **encrypted** env file. A missing or malformed variable stops the service at startup with the variable's name (never its value).

### Production secrets

The secrets live in `core/identity/.env.production`, which is git-ignored. Only its encrypted copy, `core/identity/.env.production.age`, is committed. [`.env.production.example`](.env.production.example) lists every variable to fill in.

```bash
cp core/identity/.env.production.example core/identity/.env.production   # then fill it in
pnpm env:encrypt:production                                              # writes core/identity/.env.production.age
pnpm env:check                                                           # nothing plaintext is tracked or staged
```

On the VPS, decrypt with the plain `age` CLI, as asafarim-platform's deploy does (no Node needed):

```bash
age -d -i .age/key.txt core/identity/.env.production.age > .env.identity   # the env_file in compose.snippet.yml
```

- **Two keys on the VPS.** The server needs this repository's `.age/key.txt` (chmod 600) in addition to asafarim-platform's. The keys are different, so a leaked key exposes only one repository.
- **One shared value.** The `identity_ro` password is owned here. asafarim-platform's `.env.production.age` holds a copy for the role itself, so update both files when it rotates.

## Client config

```json
{
  "clients": [
    {
      "client_id": "testora",
      "primary_domain": "testora.cloud",
      "redirect_uris": ["https://testora.cloud/api/auth/callback/asafarim"],
      "post_logout_redirect_uris": ["https://testora.cloud/"],
      "backchannel_logout_uri": "https://testora.cloud/api/auth/backchannel-logout",
      "client_secret_env": "IDENTITY_CLIENT_SECRET_TESTORA"
    }
  ]
}
```

- `client_id`: the app id (`[a-z][a-z0-9-]*`), unique.
- Every redirect, post-logout and back-channel URI must be `https` on **exactly** `primary_domain` (no subdomains, no fragments).
- `client_secret_env` names the env var holding the secret; omit it for a public client (PKCE still required).
- `name` (optional, with an optional `description`) lists the app under **Where to next** on `/account`, linked to its first post-logout URI (else `https://<primary_domain>/`). A client without a `name`, such as a test client, isn't listed. Listing grants nothing: core-api still decides who may open the app.
- Later (P3) this file is generated from the app manifests.

See `clients.example.json`.

## Keys

Generate everything for a new environment:

```bash
pnpm --filter @asafarim/identity keys
```

It prints env lines: the OIDC signing JWKS, a cookie key, the hand-off private key, and the hand-off **public** key to give Hub (`HUB_IDENTITY_TICKET_PUBLIC_JWK`). Hub generates its own Ed25519 pair; only its public half becomes `IDENTITY_HUB_PUBLIC_JWK`. The output holds private keys: put it straight into the encrypted env.

### Rotating the OIDC signing key (two keys in JWKS)

1. `pnpm --filter @asafarim/identity keys -- --signing-only` prints a new key.
2. **Publish it first:** set `IDENTITY_OIDC_JWKS` to `{"keys":[<current>, <new>]}` and deploy. The current key still signs; clients pick up the new public key from `/jwks`.
3. Wait at least the longest cache a client may hold of the JWKS (24 h).
4. **Switch:** `{"keys":[<new>, <current>]}` and deploy. The new key signs; tokens signed by the old one still verify.
5. After the longest token lifetime (the ID token is 1 h; refresh tokens are opaque and unaffected), remove the old key: `{"keys":[<new>]}`.

Cookie keys rotate the same way: prepend the new key to `IDENTITY_COOKIE_KEYS`, and drop the old one after 14 days (the session lifetime). The hand-off keys rotate in step with Hub: deploy the new public key on the verifying side before the signing side switches.

## Run

```bash
pnpm --filter @asafarim/identity start          # needs the env above
docker build -f core/identity/Dockerfile -t asafarim-os/identity .   # from the repo root
```

The image runs as `node` and works with a read-only root filesystem. `compose.snippet.yml` is the reference for P2.3: `read_only`, `cap_drop: [ALL]`, `mem_limit: 128m`, no published ports.

Logs are JSON lines with ids, codes and counts only: never tokens, codes, tickets, assertions, cookies, emails or names.

## Test

```bash
pnpm --filter @asafarim/identity test
```

- **Unit:** the hand-off verifiers (wrong audience, expired, replayed `jti`, wrong `uid`, bad signature, wrong issuer, an over-long lifetime), the client config rules, the key checks, the account mapping and log redaction.
- **SMS sign-in (`test/sms-login.test.ts`, `test/sms.test.ts`):** every route with in-memory storage: same answers for known and unknown numbers, single-use codes and the try limit, rate limits, CSRF, requests, approve and reject, revoke, the admin's access rules, no number or code in logs; plus numbers, code hashing, the Twilio sender, config and page escaping.
- **SMS integration (`test/sms.integration.test.ts`):** the Redis pieces (logical DB 14, flushed), the Postgres store in a throwaway database (`IDENTITY_TEST_DATABASE_URL`, a login that may `CREATE DATABASE`), and the OIDC round trip with the SMS method, including revocation.
- **Integration (`test/flow.integration.test.ts`):** the real provider over HTTP with a stub Hub and a stub client, against a test Redis. It runs only when `IDENTITY_TEST_REDIS_URL` is set, and flushes that DB. It covers:
  - code + PKCE → tokens;
  - no PKCE or `plain` → refused;
  - an unknown redirect URI → refused;
  - an inactive account → refused;
  - forged, misdirected and replayed assertions;
  - refresh rotation;
  - RP-initiated logout → back-channel logout;
  - Redis keys prefixed and with a TTL.

  Locally:

  ```bash
  docker run -d -p 127.0.0.1:56390:6379 redis:7-alpine
  IDENTITY_TEST_REDIS_URL=redis://127.0.0.1:56390/15 pnpm --filter @asafarim/identity test
  ```
