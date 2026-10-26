# core/admin: the Admin console

The ASafariM OS **Admin console** (P3.3b, ADR 0001 §3–4): the apps, who may do what in them, and what changed. Next.js, built with [`@asafarim/app-sdk`](../../packages/app-sdk/README.md), signing people in through [`core/identity`](../identity/README.md). It is a **core service, not an app**: it has no manifest and no database, and `core.admin` belongs to [core-api's own catalog](../core-api/README.md#the-admin-api-the-cli-and-people-p33b).

|         |                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------- |
| Locally | <http://core.localhost:8080/admin> (through the dev gateway) or <http://localhost:4030/admin>     |
| Sign in | as **Dev Admin** (the dev login stub lists the seeded users). **Dev Member** gets a real **403**. |
| Pages   | **Apps**, **Status**, **Events**, **Roles & grants**, **Audit**                                   |

## How it authenticates (and what it can't do)

1. Sign-in is OIDC against identity (code + PKCE), as for any app; the OIDC client is `core-admin`.
2. The **ID token stays on the server**, inside the encrypted session cookie. It is never in the session object the browser can read.
3. Every page and every action sends that token to core-api's admin API as `Bearer`. **core-api** verifies it, checks `core.admin` **per request**, and audits the action as `user:<sub>`. The console holds **no admin secret** and does no authorisation of its own beyond asking: a revoked administrator is refused on their next click.
4. The session is capped at the ID token's hour; an expired one sends the person to sign in.
5. A signed-out visitor goes straight to identity (`/signin/start`), with no Sign in button to click: someone already signed in there (they came from the OS home page's menu, identity's header or the app switcher) is back in the console at once. If they come back signed out within a minute, they get `/signin` with its button instead of another round trip. `/signin` is also where signing out lands.

**Bootstrap:** the first administrator is made with the CLI, never by the console: `pnpm platform role grant core.admin <sub>` (`pnpm dev` does it for `dev-admin`). An administrator can't revoke their own `core.admin`.

## What each page does

- **Apps**: every app with its state and install status (waiting for the app to register, or registered at a time). **Activate** serves it at its address and puts it in launchers; **Deactivate** shows the "temporarily unavailable" page and takes it off launchers; data is kept. Both ask first, in a styled dialog. **Remove** (an installed or inactive app; deactivate an active one first) asks you to type the app id before its button is enabled: core-api deletes the app's event consumers, its subscribers' consumers and its stream (with any events not yet delivered), revokes its credentials, deletes every grant of its roles and deprecates them. Apps subscribed to its events show **Waiting for publisher**. Before any of that, core-api backs up the app's database (if that fails, nothing is removed); the database is then kept for the retention window. A removed app stays in the list as **removed**, with its backup (size, time, path, sha256) and its purge date. **Purge** (a removed app with a backed-up database) also asks for the typed app id: core-api checks that the backup file is still there and unchanged, then drops the database and its role. Before the purge date the button reads **Purge early** and forces it. Installing an app again (CLI) before its purge keeps its data; after it, the app starts with an empty database. `core` is built in and always active.
- **Status** (P6.1): core-api's `GET /admin/v1/status`: core-api itself and every installed app, with **Up** / **Down** / **Unknown** badges (text, not color only) for its manifest's `live` and `ready` endpoints, the latency, when it was last checked, since when it's been in that state, and the problem (timeout, refused, an error status…). Installed and inactive apps show **Not polled**. Read-only; **Refresh** reloads the page.
- **Events** (P4.2): the event catalog from core-api's `GET /admin/v1/events`, sorted by type: the publisher (app and version), the schema status (provided, or "no schema uploaded") with the schema itself as collapsed, pretty-printed JSON, and each subscriber with its handler and consumer state. A type nobody publishes is flagged **No publisher** and its subscribers **Waiting for publisher** (the Apps page's warning). `?app=<id>` keeps the types that app publishes or subscribes to; an invalid value is ignored. Read-only.
- **Roles & grants**: per app, its roles, the permissions each grants, who holds each, and **Revoke** (with a dialog). **Grant** by searching the seeded users (locally; there is no production directory yet, so you can also type a subject id). A role that still grants a permission the app no longer declares is flagged **Migration needed** (ADR 0001 §3.4).
- **Audit** (three tabs, every one usable on a phone):
  - **Overview** (`/admin/audit?days=7|14|30`): counts (sign-ins, failed or refused, waiting for access, people with access, admin changes), **Needs attention** (people waiting for approval with a link to identity's admin page, a spike of failed sign-ins today, refused admin access, `core.admin` grants and revocations, removals and purges), a stacked activity chart per day (plain HTML bars, with the numbers as a table), the newest events of both trails, and the busiest admin actions and actors.
  - **Admin changes** (`/admin/audit/changes`): core-api's audit events in plain sentences with a tone badge, filterable by app, kind or action, actor, the person involved and dates; "Older events" pages. Old `/admin/audit?app=…` links redirect here.
  - **Sign-ins & access** (`/admin/audit/sign-ins`): identity's trail (`GET /admin/v1/audit` on identity, with the admin's ID token; identity shows it only to its own admins): sign-ins, failures, codes, access requests and decisions, connections, passkeys, refused admin access. Filter by kind, method and dates; click a person for everything about them, or an address fingerprint for every attempt from it.
  - **Export CSV** on both lists (`/admin/audit/export`): the page's filters, up to 2 000 rows, formula-looking cells neutralised.

Every write goes through a server action that re-checks the administrator, calls the admin API, and returns to the page with a message (`role="status"` / `role="alert"`). Return paths are limited to `/admin…`.

## In production

<https://admin.asafarim.site>, the `os-admin` service of [`deploy/compose.prod.yml`](../../deploy/compose.prod.yml) (image from `core/admin/Dockerfile`, published by the "Admin image" workflow). It runs with the **core** stack: `deploy/vps-deploy.sh` starts it when the commit has `core/core-api/.env.production.age` **and** `core/admin/.env.production.age`, and `deploy/redeploy.sh` passes its image sha as the sixth argument. It reaches core-api at `http://os-core-api:4020` on the private `os_core` network and identity at its public URL; the edge proxies the site (`sites/asafarim-os.caddy`).

| Variable             | Where                            | What                                                                                                                                |
| -------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`        | `core/admin/.env.production.age` | Auth.js's session secret (≥ 32 random bytes)                                                                                        |
| `OIDC_CLIENT_SECRET` | the same file                    | the `core-admin` client's secret; identity holds the same value as `IDENTITY_CLIENT_SECRET_ADMIN` (`core/identity/.env.production`) |

The `core-admin` client goes in the VPS's `deploy/identity/clients.json` (not in git):

```json
{
  "client_id": "core-admin",
  "primary_domain": "admin.asafarim.site",
  "redirect_uris": ["https://admin.asafarim.site/api/auth/callback/asafarim"],
  "post_logout_redirect_uris": ["https://admin.asafarim.site/"],
  "client_secret_env": "IDENTITY_CLIENT_SECRET_ADMIN"
}
```

**First administrator (once, on the VPS):** `deploy/core-api/admin.sh grant core.admin <account id>` (the id is on <https://id.asafarim.site/account>). From then on, an administrator grants and revokes roles (for example `docs.owner`) under **Roles & grants**, with no SSH. Permissions are cached for up to 60 seconds.

## Accessibility and themes

A skip link; landmarks (`banner`, `navigation "Admin"`, `main`); one `h1`; captioned tables with column and row headers; every control has a name; visible focus. Confirmation is a native modal `<dialog>` (never `window.confirm`): the browser traps focus, **Escape cancels**, focus returns to the button, and **Cancel has focus first**, so a stray Enter can't confirm. Light and dark follow `prefers-color-scheme`; the e2e checks contrast of at least 4.5:1 in both.

## Develop

```bash
pnpm dev                                  # the whole OS, including this (port 4030)
pnpm --filter @asafarim/admin dev         # just the console (needs core-api and identity running)
pnpm --filter @asafarim/admin test        # unit tests
pnpm e2e                                  # the whole OS in a real browser: notes, then the console (e2e/admin.spec.ts)
```

Settings come from `.dev/app.env` and `.dev/admin.env`: `OIDC_ISSUER`, `AUTH_SECRET`, `CORE_API_URL`, `ADMIN_OIDC_CLIENT_ID` (default `core-admin`) and `ADMIN_USER_DIRECTORY_FILE` (the seeded users). See `.env.development.example`.

Traces and metrics (P6.2) are off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set; then they go over OTLP/HTTP as service `admin` with this package's version, and are flushed when the server shuts down (`instrumentation.ts`).

## What it does not cover

- **No production directory of people.** Locally it searches the seeded users; elsewhere, grant by typing the subject id.
- **No install or manifest editing.** Install (and reinstall after a removal) is the CLI (`platform app install`); the console activates, deactivates and removes.
- **Remove keeps the app's OIDC client**, and doesn't cut the removed app's open bus connections (new ones are refused). Its database is backed up and kept until an administrator purges it: nothing purges on a schedule.
- **Deploy is the owner's:** see [In production](#in-production). Nothing deploys it automatically.
