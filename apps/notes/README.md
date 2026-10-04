# apps/notes

**Notes**, the first built-in reference app of ASafariM OS (P3.2). It's tiny on purpose: list notes and create one. It exists to prove the plug-and-play contract end to end:

1. a folder with a manifest (`platform.app.ts`) and nothing else to wire up;
2. `platform app install notes` gives it **its own database** and a registry credential;
3. on boot it **registers itself** with core-api (signed);
4. people **sign in through `core/identity`** (the dev login stub locally);
5. what they may do is **granted by an admin** (`platform role grant`), never by the app.

| Permission    | What          | Roles that carry it            |
| ------------- | ------------- | ------------------------------ |
| `notes.read`  | list notes    | `notes.viewer`, `notes.editor` |
| `notes.write` | create a note | `notes.editor`                 |

`GET /api/notes` needs `notes.read`; `POST /api/notes` needs `notes.write`. A refusal is `403` and **names the permission**: `{ "error": "forbidden", "permission": "notes.write" }`. An app that isn't `active` answers `503 app_inactive` before any permission check. `limits.maxNotes` (default 100) is a typed config key from the manifest.

## Try it

```bash
pnpm dev     # installs and activates notes, then runs it on http://localhost:4100
```

Sign in as **Dev Member** (the dev login stub lists the seeded users). The member has no roles yet:

```bash
pnpm platform role grant notes.viewer dev-member   # can read, can't write (403 naming notes.write)
pnpm platform role grant notes.editor dev-member   # can write
pnpm platform app deactivate notes                 # the app reports inactive (503)
```

The permission cache is 1 s in development, so changes show on the next reload.

**Through the gateway** (the front door: the lifecycle page, `expose: false` and permission-marked routes are enforced there): <http://notes.localhost:8080>. Sign in there and `GET /api/notes` is checked by the gateway before the app sees it (403 naming the permission, from the gateway). A role you grant or revoke applies within the access token's lifetime (60 s; 1 s of cache for direct access). `/internal/ping` answers when you go straight to :4100 and is a 404 at the gateway (`expose: false`).

## Test

```bash
pnpm --filter @asafarim/notes test   # the manifest
pnpm e2e                             # the whole flow in a real browser (Playwright)
```

`pnpm e2e` starts Postgres, Redis, the dev gateway, identity, core-api (with a 6 s access-token lifetime), the dev stub and notes (a production build), installs the app, and runs `e2e/notes.spec.ts` (direct, P3.2) and `e2e/gateway.spec.ts` (through `http://notes.localhost:8080`, P3.3a). The first time: `pnpm --filter @asafarim/notes exec playwright install chromium`. Screenshots land in `apps/notes/test-results/screens/`. CI runs it as the `notes-e2e` job and uploads them.

## Layout

| Path                        | What                                                                         |
| --------------------------- | ---------------------------------------------------------------------------- |
| `platform.app.ts` / `.json` | the manifest (and its compiled form, which `platform sync` reads)            |
| `instrumentation.ts`        | starts the SDK on boot: registration                                         |
| `lib/platform.ts`           | one SDK instance per server process                                          |
| `lib/gate.ts`               | signed in? app active? has the permission? one decision for the page and API |
| `lib/auth.ts`               | Auth.js through `asafarimAuthConfig`                                         |
| `lib/db.ts`                 | the app's own database (`DATABASE_URL`) and its one table                    |
| `app/`                      | the page, the server actions and `api/notes`, `api/health`                   |

The core never imports this app: `pnpm platform:boundaries` proves it.
