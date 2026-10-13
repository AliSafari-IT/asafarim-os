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
pnpm platform app install --image <ref> [--env-out <file>]
                                        # install an app from another repository by its image
pnpm platform app new <id> [--name "<Display name>"] [--root <dir>]
                                        # write a minimal app to <dir>/apps/<id>/ (installs nothing)
```

`--other-stack-sites <file>` lists gateway sites that belong to **another stack
sharing the same edge** (one host per line, `#` comments allowed). The drift
report shows them under "Other stacks on the same edge (not drift)" instead of
as unclaimed sites.

## External apps (`app install --image`)

An app that lives in another repository is installed from its image. Its manifest
travels in the image's OCI label `org.asafarim.app.manifest` (the whole
`platform.app.json`), set when the image is built:

```bash
docker build --label "org.asafarim.app.manifest=$(cat platform.app.json)" -t <ref> .
pnpm platform app install --image <ref>
pnpm platform sync
```

The CLI reads the label with `docker image inspect` (pulling the image only when it
isn't local) and validates it with the same schema as an in-repo manifest. A missing,
non-JSON or invalid label stops it before core-api is called or anything is written.
It also refuses an id that `apps/<id>/` already has, and `auth.client: "none"` with
declared permissions or roles (such an app keeps its own sign-in). After core-api
accepts the install, the manifest is recorded in `external-apps/<id>/platform.app.json`
with `source.json` (`{ "image": "<ref>" }`), so `sync` generates its launcher tile and
gateway site exactly as for `apps/<id>/`. An `oidc` app also needs an OIDC client at
identity, which this command doesn't create.

The published JSON Schema is at
`https://asafarim.site/schemas/app-manifest.schema.json` (and `/schemas/app-manifest/v1.json`).
`fixtures/external-app/` is a made-up external app; `pnpm e2e` builds it, installs it this
way and checks the Admin Status board shows it up.

## New app (`app new <id>`)

`app new` writes a minimal Next.js app to `<root>/apps/<id>/` from the files in `templates/app/`: a typed
manifest (`platform.app.ts`) and its compiled `platform.app.json`, a page that signs in through core/identity and
shows the launcher, `/health/live` and `/health/ready`, telemetry, and one test. Placeholders (`{{id}}`, `{{name}}`,
`{{glyph}}`, `{{port}}`) are replaced and a `.tmpl` suffix is dropped. The id is checked with the manifest schema's own
rules and an id that is reserved, already used under `apps/`, `external-apps/`, `core/`, `packages/` or `tools/`, or that is already the name of a workspace package (`@asafarim/<id>`) is refused. The folder is
written next to its place and renamed into it, so a failure leaves nothing behind. It only writes files: run
`pnpm install` and `pnpm platform sync` after it; installing in core-api (`app install`), the OIDC client and any
deploy stay separate steps. `--name` is the display name (default: the id in title case).

## Generators

`sync` reads `<root>/apps/<id>/platform.app.json` and `<root>/external-apps/<id>/platform.app.json`
only (compile a `platform.app.ts` first) and never executes app code, so `--root` can point at
another checkout. Two manifests with the same id are refused.

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
- **Apps installed from an image** are read **only** from their `platform.app.json`,
  delivered as the OCI image label (`app install --image` parses it as JSON and
  never starts the image). The CLI and the core API **never execute app code** for
  an installed app. Any other install path must use the JSON-only loader
  (`loadManifestFile(file, { jsonOnly: true })`), never the module loader.
