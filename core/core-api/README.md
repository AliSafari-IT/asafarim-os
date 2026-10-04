# core/core-api

The ASafariM OS control plane (P3.1, ADR 0001 §3–4): the **app registry**, install records, signed **self-registration**, the **lifecycle** (installed → active ⇄ inactive) and the **permission catalog**. Apps _declare_ permissions and roles; only admins _grant_ them.

Node 24 (runs the TypeScript directly), Postgres (its own `core` database), no framework.

## Run

`pnpm dev` starts it (on <http://localhost:4020>) with its database bootstrapped and its env in `.dev/core-api.env`. On its own:

```bash
node --env-file=../../.dev/core-api.env src/server.ts
```

| Env                              | What                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `CORE_API_DATABASE_URL`          | the `core` database as its owner role `core_api`; migrations in `migrations/` run at start            |
| `CORE_API_PROVISIONER_URL`       | a role that may `CREATE ROLE` / `CREATE DATABASE`; used only to install apps                          |
| `CORE_API_ADMIN_TOKEN`           | ≥ 32 characters; the admin endpoints' bearer token until the admin console's OIDC sign-in replaces it |
| `PORT`                           | default `4020`                                                                                        |
| `CORE_API_APP_DB_HOST` / `_PORT` | host and port put into an installed app's `DATABASE_URL` (default: the provisioner's)                 |

## Install (admin)

```bash
pnpm platform manifest compile apps/notes/platform.app.ts
pnpm platform app install notes --env-out .dev/notes.env     # or without --env-out: printed once
pnpm platform app activate notes                              # deactivate: the same
```

`POST /admin/v1/apps/<id>/install`, `Authorization: Bearer <admin token>`, body = the manifest JSON:

1. validates it with `@asafarim/app-manifest`, and requires `manifest.id` to match `<id>`;
2. creates the app's **own database and login role** (`app_<id>`, with `REVOKE CONNECT … FROM PUBLIC`), using the same helper as the dev bootstrap (`src/provision.ts`);
3. issues a **registry credential** and stores only its verifier;
4. returns, **once**:

```json
{
  "appId": "notes",
  "state": "installed",
  "credential": "osk1.notes.3f9a1c0b7e2d.MC4CAQAw…",
  "keyId": "notes.3f9a1c0b7e2d",
  "database": { "name": "app_notes", "role": "app_notes", "url": "postgres://app_notes:…@127.0.0.1:55440/app_notes" }
}
```

## Self-registration (the app, on every boot)

`POST /registry/v1/apps/<id>`. The body is the app's current manifest as JSON, signed with its credential.

### Signing scheme: `ed25519-v1`

The credential is `osk1.<keyId>.<PKCS#8 Ed25519 private key, base64url>`. core-api stores only the **public** key, so a database leak can't forge a registration. The choice of Ed25519 over HMAC is proposed and pending the architect: see asafarim-platform#723. The scheme sits behind `CredentialScheme` in `src/credentials.ts`.

| Header                 | Value                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `x-asafarim-timestamp` | unix seconds; accepted within **±60 s**                                                |
| `x-asafarim-nonce`     | 22–128 base64url characters, random; **single use** (replay cache, pruned after 2 min) |
| `x-asafarim-key-id`    | the credential's key id                                                                |
| `x-asafarim-signature` | `v1=<base64url Ed25519 signature>`                                                     |

The signature covers the canonical string (lines joined with `\n`; the protocol lives in `@asafarim/registry-protocol`, shared with the app SDK):

```
v1
<timestamp>
<nonce>
POST
/registry/v1/apps/<id>
<sha256 of the exact request body, lower-case hex>
```

`signRegistration({ appId, credential, body })` in `src/credentials.ts` builds the headers; the app SDK uses it.

### What registration does

- **Upserts** the manifest and version.
- **Permissions:** new ones are added, re-declared ones restored, and removed ones **deprecated** (`deprecated_at`), never deleted.
- **Roles:** the same rules. Their permissions come from `grants`: the app's own keys, or `<id>.*` for all of them.
- **Event subscriptions** are replaced with what the manifest declares.
- Writes an audit event.

**It can't grant anything.** It never writes `role_grants` (who holds a role) and never changes the app's state.

Response `200`:

```json
{
  "appId": "notes",
  "version": "0.2.0",
  "state": "installed",
  "permissions": { "added": ["notes.notes.share"], "restored": [], "deprecated": ["notes.notes.write"] },
  "roles": { "added": [], "deprecated": [] }
}
```

### Safety rules (each has a test in `test/registry.integration.test.ts`)

- Registration can't grant: no role grants, no state change; a role granting another app's permission or `*` is refused.
- Everything an app declares must be inside **its own namespace**: permissions, roles and their grants, route permissions and published events, all under `<id>.*`.
- An **unknown app** (no install record, or removed) can't register.
- A **bad**, **expired** or **replayed** signature is refused. Signature checks run first, so a forged request can't burn a real nonce.

## What an app may do (P3.2)

### `GET /registry/v1/apps/<id>/subjects/<sub>` (signed by the app)

The app asks what a subject may do **in this app**. The request is signed like a registration, but it's a `GET` with an empty body: the canonical string carries `GET` and the exact path, **including the subject**, so a signature for one subject can't be replayed for another, and a `POST` signature isn't a `GET` signature. The nonce is single use.

```json
{
  "appId": "notes",
  "subject": "dev-member",
  "state": "active",
  "roles": ["notes.viewer"],
  "permissions": ["notes.read"]
}
```

Only roles an admin granted count, and **deprecated roles and permissions grant nothing**. `state` lets an inactive app say so. The app SDK caches the answer for 60 s and fails closed when core-api is unreachable.

### Granting roles (admin)

Apps _declare_ roles; **only an admin grants them**. `PUT /admin/v1/roles/<role>/grants/<sub>` gives the subject (an identity `sub`) the role; `DELETE` takes it back. Both are idempotent and audited (`role.granted`, `role.revoked`; a repeat writes nothing). A role that doesn't exist (or, for a grant, is deprecated) → `404 role_not_found`.

```bash
pnpm platform role grant notes.editor dev-member
pnpm platform role revoke notes.editor dev-member
```

## Lifecycle (admin)

`POST /admin/v1/apps/<id>/activate` (from `installed` or `inactive`) and `…/deactivate` (from `active`). Each writes an audit event. The gateway and launcher effects arrive in P3.3. `GET /admin/v1/apps/<id>` shows the app, its permissions and its roles.

## Errors

Every non-2xx response is JSON `{ "error": "<code>", "message": "…", "details"?: … }`:

| Code                        | Status    | When                                                                              |
| --------------------------- | --------- | --------------------------------------------------------------------------------- |
| `unauthorized`              | 401       | admin endpoint without the right bearer token                                     |
| `missing_signature`         | 401       | registration without the four `x-asafarim-*` headers, or malformed ones           |
| `bad_signature`             | 401       | the signature doesn't verify (wrong key, tampered body, wrong key id)             |
| `expired_signature`         | 401       | timestamp outside ±60 s                                                           |
| `replayed_signature`        | 401       | the nonce was already used                                                        |
| `unknown_app`               | 403       | no install record (or removed)                                                    |
| `app_id_mismatch`           | 422       | `manifest.id` ≠ the id in the URL                                                 |
| `invalid_manifest`          | 422       | fails manifest validation (`details`: path + message per problem)                 |
| `namespace_violation`       | 422       | declares something outside `<id>.*`                                               |
| `already_installed`         | 409       | install of an installed app                                                       |
| `invalid_state`             | 409       | a lifecycle change not allowed from the current state                             |
| `role_not_found`            | 404       | a grant or revoke names a role that doesn't exist (or is deprecated, for a grant) |
| `not_found` / `bad_request` | 404 / 400 | —                                                                                 |

## Test

```bash
pnpm --filter @asafarim/core-api test
```

The integration suite runs only with `CORE_API_TEST_ADMIN_URL`, a superuser URL on a **dev** Postgres such as `postgres://postgres:postgres-dev-only@127.0.0.1:55440/postgres` from `pnpm dev`. It creates a throwaway core database and uniquely named app databases, and drops them all afterwards. CI's `dev-env` job runs it with `CORE_API_TEST_REQUIRED=1`, so it fails rather than skips.
