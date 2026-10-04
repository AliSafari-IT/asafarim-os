# ASafariM OS

A small core platform for business applications, and apps that plug into it.

- **The core** handles what every app needs: routing and TLS at the gateway, sign-in, a registry of installed apps, permissions, configuration, an event bus and observability. It never depends on a specific app.
- **Apps are self-describing plugins.** Each app ships a manifest that declares its domains, runtime, database, permissions, routes, events and configuration. The platform wires the app in from that manifest. Each app owns its own database and talks to other apps through events, never through another app's code or tables.

## Repository layout

| Path                  | Holds                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `packages/`           | shared libraries, such as the configuration presets (`@asafarim/config`)                     |
| `core/`               | core services                                                                                |
| `apps/`               | built-in apps, one folder per app (`apps/<id>/`)                                             |
| `tools/platform-cli/` | the `platform` CLI                                                                           |
| `generated/platform/` | files generated from the app manifests, committed and checked in CI. Don't edit them by hand |

## Develop

Requirements: **Node 24** (see `.nvmrc`), **pnpm** (the version pinned in `package.json`; `corepack enable` picks it up) and **Docker** (Desktop or the daemon).

### Run the OS locally

```bash
pnpm install
pnpm dev
```

`pnpm dev` does everything, every time, and is safe to repeat:

1. checks Docker;
2. creates throwaway dev keys and passwords in `.dev/` (git-ignored) if they're missing;
3. starts Postgres 16 and Redis 7 from `compose.dev.yml`, on **127.0.0.1 only**;
4. creates each service's database and login role, revokes `CONNECT` from `PUBLIC`, runs migrations and seeds synthetic users;
5. runs `core/identity`, the dev login stub and every `apps/*` in watch mode.

| What                      | URL                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------- |
| Identity (OIDC discovery) | <http://localhost:4010/.well-known/openid-configuration>                              |
| Dev login stub            | <http://localhost:4000>                                                               |
| Postgres / Redis          | `127.0.0.1:55440` (user `postgres`, password `postgres-dev-only`) / `127.0.0.1:56380` |
| Dev OIDC client           | `client_id=dev-app`, public, PKCE S256, redirect `http://localhost:4100/callback`     |

**Signing in locally.** In production, the identity service hands login to Hub (asafarim-platform). Locally it hands it to **`tools/dev-hub`**, a stub that lists the seeded **synthetic** users (`dev-owner`, `dev-admin`, `dev-member`, and `dev-inactive`, which is refused) and signs the hand-off with a dev-only key. You don't need an asafarim-platform checkout. The stub **refuses to start** unless `NODE_ENV=development` and the identity issuer is on `localhost`, and it never ships in an image. The users are in `tools/dev-hub/seed-users.json`.

```bash
pnpm dev:smoke   # the whole flow, end to end: bootstrap twice, /readyz, a sign-in → ID token (CI runs this)
pnpm dev:keys    # create missing dev keys; --force replaces them (signs everyone out)
pnpm dev:reset   # delete the local dev databases and Redis data (asks first; --keys also deletes .dev/)
```

**Troubleshooting**

- **"Docker isn't running":** start Docker Desktop and run `pnpm dev` again.
- **A port is in use (4000, 4010, 55440, 56380):** stop whatever holds it. These ports were picked to avoid asafarim-platform's.
- **Sign-in says `browser_mismatch`:** finish the sign-in in the same browser tab you started it in.
- **Anything odd with the data:** `pnpm dev:reset`, then `pnpm dev`.

`.env.development.example` documents every generated variable. You never copy it by hand.

### Checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm platform:sync:check   # fails if generated/platform/ is out of date
```

`pnpm platform:sync` regenerates `generated/platform/` from the manifests under `apps/`.

Tooling: pnpm workspaces, Turborepo, TypeScript, Vitest, ESLint and Prettier. CI runs every check above on each pull request, plus a CodeQL scan.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

Source-available for evaluation only. See [LICENSE](LICENSE). It isn't an open-source licence: using, copying or deploying the code needs written permission.
