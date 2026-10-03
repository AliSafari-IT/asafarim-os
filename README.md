# ASafarIM OS

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

Requirements: **Node 24** (see `.nvmrc`) and **pnpm** (the version pinned in `package.json`; `corepack enable` picks it up).

```bash
pnpm install
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
