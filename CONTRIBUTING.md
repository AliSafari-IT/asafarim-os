# Contributing

## Workflow

- Branch from `main`, open a pull request, and merge only when CI is green. `main` takes no direct pushes.
- Keep a pull request to one change, and list what it doesn't cover.
- Run the checks locally before pushing:

  ```bash
  pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm platform:sync:check
  ```

## Rules the code follows

- **The core never imports an app.** Nothing in `core/` or `packages/` may import from `apps/` or hard-code an app id.
- **Apps never import other apps.** They integrate through events or a declared public API.
- **Namespaces:** an app's permissions, roles and event types live under its own id (`<id>.…`).
- **Registering an app grants nothing.** Only an admin assigns roles.
- **Secrets:** manifests list secret _names_ only. Values never go in git.
- **Resources:** every service declares its memory and CPU limits.
- **Generated files** in `generated/platform/` are never edited by hand.

## Licence

By contributing you agree that your contribution is covered by the repository's [LICENSE](LICENSE).
