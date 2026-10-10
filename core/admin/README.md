# core/admin: the Admin console

The ASafariM OS **Admin console** (P3.3b, ADR 0001 §3–4): the apps, who may do what in them, and what changed. Next.js, built with [`@asafarim/app-sdk`](../../packages/app-sdk/README.md), signing people in through [`core/identity`](../identity/README.md). It is a **core service, not an app**: it has no manifest and no database, and `core.admin` belongs to [core-api's own catalog](../core-api/README.md#the-admin-api-the-cli-and-people-p33b).

|         |                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------- |
| Locally | <http://core.localhost:8080/admin> (through the dev gateway) or <http://localhost:4030/admin>     |
| Sign in | as **Dev Admin** (the dev login stub lists the seeded users). **Dev Member** gets a real **403**. |
| Pages   | **Apps**, **Events**, **Roles & grants**, **Audit**                                               |

## How it authenticates (and what it can't do)

1. Sign-in is OIDC against identity (code + PKCE), as for any app; the OIDC client is `core-admin`.
2. The **ID token stays on the server**, inside the encrypted session cookie. It is never in the session object the browser can read.
3. Every page and every action sends that token to core-api's admin API as `Bearer`. **core-api** verifies it, checks `core.admin` **per request**, and audits the action as `user:<sub>`. The console holds **no admin secret** and does no authorisation of its own beyond asking: a revoked administrator is refused on their next click.
4. The session is capped at the ID token's hour; an expired one sends the person to sign in.

**Bootstrap:** the first administrator is made with the CLI, never by the console: `pnpm platform role grant core.admin <sub>` (`pnpm dev` does it for `dev-admin`). An administrator can't revoke their own `core.admin`.

## What each page does

- **Apps**: every app with its state and install status (waiting for the app to register, or registered at a time). **Activate** serves it at its address and puts it in launchers; **Deactivate** shows the "temporarily unavailable" page and takes it off launchers; data is kept. Both ask first, in a styled dialog. **Remove** (an installed or inactive app; deactivate an active one first) asks you to type the app id before its button is enabled: core-api deletes the app's event consumers, its subscribers' consumers and its stream (with any events not yet delivered), revokes its credentials, deletes every grant of its roles and deprecates them. Apps subscribed to its events show **Waiting for publisher**. Its database is kept. A removed app stays in the list as **removed**, with no action; installing it again (CLI) starts clean. `core` is built in and always active.
- **Events** (P4.2): the event catalog from core-api's `GET /admin/v1/events`, sorted by type: the publisher (app and version), the schema status (provided, or "no schema uploaded") with the schema itself as collapsed, pretty-printed JSON, and each subscriber with its handler and consumer state. A type nobody publishes is flagged **No publisher** and its subscribers **Waiting for publisher** (the Apps page's warning). `?app=<id>` keeps the types that app publishes or subscribes to; an invalid value is ignored. Read-only.
- **Roles & grants**: per app, its roles, the permissions each grants, who holds each, and **Revoke** (with a dialog). **Grant** by searching the seeded users (locally; there is no production directory yet, so you can also type a subject id). A role that still grants a permission the app no longer declares is flagged **Migration needed** (ADR 0001 §3.4).
- **Audit**: core-api's audit events, newest first, filterable by app and by (part of) the actor; "Older events" pages.

Every write goes through a server action that re-checks the administrator, calls the admin API, and returns to the page with a message (`role="status"` / `role="alert"`). Return paths are limited to `/admin…`.

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

## What it does not cover

- **No production directory of people.** Locally it searches the seeded users; elsewhere, grant by typing the subject id.
- **No install or manifest editing.** Install (and reinstall after a removal) is the CLI (`platform app install`); the console activates, deactivates and removes.
- **Remove keeps the app's database and OIDC client**, and doesn't cut the removed app's open bus connections (new ones are refused). Backup, drop and retention are a later, deploy-level step.
- **No Dockerfile or deploy yet:** this is local and CI; deployment arrives with the rest of ADR 0001 §8.
