# core/identity

The ASafariM OS identity service: the **OpenID Connect provider** for `id.asafarim.site`. Apps on their own domains (first: Testora on `testora.cloud`) sign people in through it. **Login itself stays in Hub**: the provider hands the browser to Hub with a signed ticket, and Hub posts back a signed assertion. Design: ADR 0002 and its Addendum A (private docs, `ventures/asafarim-os/adr/0002-…`).

It runs [`oidc-provider`](https://github.com/panva/node-oidc-provider) (major version 9) on Node 24, which runs the TypeScript directly (no build step).

## What it enforces

| Policy            | Value                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| Flows             | authorization code only (no implicit, no hybrid)                                                          |
| PKCE              | required for every client, `S256` only                                                                    |
| ID token          | `ES256`                                                                                                   |
| Access token      | 10 min                                                                                                    |
| Refresh token     | only with `offline_access` (which needs `prompt=consent`), rotated on every use; reusing an old one fails |
| Logout            | RP-initiated logout, plus back-channel logout to every client in the session                              |
| Consent           | none shown: every client is a first-party ASafariM app; the grant covers exactly the scopes requested     |
| Accounts          | from the platform's `identity_accounts_v` view, read-only; an inactive or unknown account gets no tokens  |
| Outbound requests | oidc-provider's SSRF guard stays on: back-channel logout never calls loopback or private addresses        |

Endpoints: discovery (`/.well-known/openid-configuration`), `/jwks`, `/auth`, `/token`, `/me` (userinfo), `/session/end`, `/token/revocation`, plus `/healthz` (live) and `/readyz` (Redis and accounts DB).

## Login hand-off (ADR 0002, A2)

1. A client starts the code flow at `/auth`. The provider creates an interaction (`uid`) and sends the browser to `/interaction/<uid>`.
2. The service signs a **ticket** (Ed25519, `iss=id`, `aud=hub`, `uid`, a nonce, `exp` ≤ 120 s) and redirects to `IDENTITY_HUB_CONTINUE_URL?ticket=…`.
3. Hub signs the person in (or reuses its session) and auto-POSTs an **assertion** to `/interaction/<uid>/hub` as the form field `assertion`. The assertion is an Ed25519 JWS with `iss=hub`, `aud=id`, `sub` (the platform user id), the same `uid`, `exp` ≤ 60 s and a single-use `jti`.
4. The service verifies it: the signature (with Hub's pinned key), the issuer, the audience, the lifetime, the `uid`, and that the `jti` hasn't been seen (Redis). The account must exist and be active.
5. It does **not** finish the login yet. Hub's POST is cross-site, so the browser doesn't send the provider's (SameSite=Lax) interaction cookie with it, and nothing proves the posting browser is the one that started the sign-in. Instead it **parks** the verified `sub` in Redis (keyed by `uid`, 60 s, single-use), sets a random **completion cookie** scoped to `/interaction/<uid>/complete` (only its SHA-256 is stored), and answers `200` with a page that navigates to that path. It must not redirect: Hub's assertion page has `form-action <issuer>`, and Chromium applies that to every redirect in the chain, so a redirect to the client's origin is blocked.
6. `GET /interaction/<uid>/complete` is a top-level GET, so the browser sends both cookies. It finishes the interaction with `accountId = sub` **only** if the completion cookie matches the parked login **and** the provider's interaction cookie is there (`interactionDetails` succeeds for this `uid`). That means the same browser started the sign-in and posted the assertion. Otherwise: `browser_mismatch`, and nothing is finished.

**Why both cookies:** if someone else's signed-in browser opens your continue link, it can post an assertion for _their_ account, but it doesn't hold your interaction cookie, so it can't finish your sign-in. Your browser holds the interaction cookie but never received the completion cookie, so it can't finish with their account either. Without this step, an interaction could be completed with a different person's account (asafarim-platform#723, review of #23).

Any failure shows a styled error page with a short code (`assertion_replayed`, `account_inactive`, `browser_mismatch`, …) and logs nothing that identifies the person; there is no partial login.

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
