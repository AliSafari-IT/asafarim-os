# @asafarim/platform-cli

The `platform` command: discovers app manifests and generates the platform
wiring from them.

```bash
pnpm platform sync [--root <dir>]       # generate <dir>/generated/platform/ from the app manifests
pnpm platform sync --check [--root <dir>]
                                        # fail when generated/platform/ has drifted (CI)
pnpm platform sync --check --against <dir> [--other-stack-sites <file>]
                                        # compare <dir>/apps/*/platform.app.json with that
                                        # checkout's hand-written wiring (read-only)
pnpm platform manifest validate <file>  # check one manifest (.json, or a .ts default export)
pnpm platform manifest compile <file>   # validate and write platform.app.json beside it
pnpm platform boundaries                # fail if core/ or packages/ import from apps/
```

`--other-stack-sites <file>` lists gateway sites that belong to **another stack
sharing the same edge** (one host per line, `#` comments allowed). The drift
report shows them under "Other stacks on the same edge (not drift)" instead of
as unclaimed sites.

## Generators

`sync` reads `<root>/apps/<id>/platform.app.json` only (compile a `platform.app.ts`
first) and never executes app code, so `--root` can point at another checkout.

| Output                                      | From                                                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generated/platform/launcher-registry.json` | every manifest with a `ui.launcher` block, ordered by `order`, then id                                                                                                           |
| `generated/platform/gateway/dev.Caddyfile`  | the dev gateway: a host per app (`<id>.localhost:8080`), `expose: false` → 404, `forward_auth` to core-api; always generated (it also serves `id.localhost` and `api.localhost`) |

A file under `generated/platform/` that no generator produces is drift; `sync` refuses
to leave it in place.

## Security: app code is never executed for apps you don't own

Loading a `platform.app.ts` (or `.js`) manifest **executes that module** to read
its default export. That is acceptable only for **in-repo, trusted apps**:

- `manifest validate` and `manifest compile` load a module manifest **only when
  it lies inside the workspace** the command runs in (the nearest
  `pnpm-workspace.yaml`). A module outside it is refused.
- `sync --check --against <dir>` reads **`platform.app.json` only**. It never
  executes another checkout's manifest code; an app that ships only a
  `platform.app.ts` is reported as a problem ("compile it first"). Compile in
  that repository's own trusted context: `platform manifest compile
apps/<app>/platform.app.ts`, run from that repository.
- **Apps installed from an image** (a later phase) are read **only** from their
  `platform.app.json`, delivered as an OCI image label or served at
  `/.well-known/`. The CLI and the core API **never execute app code** for an
  installed app. Any future install path must use the JSON-only loader
  (`loadManifestFile(file, { jsonOnly: true })`), never the module loader.
