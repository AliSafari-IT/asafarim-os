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
pnpm platform manifest review [<id>…] [--json] [--strict] [--root <dir>]
                                        # compare apps' manifests with their code (advisory)
pnpm platform boundaries                # fail if core/ or packages/ import from apps/
pnpm platform app install --image <ref> [--env-out <file>]
                                        # install an app from another repository by its image
pnpm platform app new <id> [--name "<Display name>"] [--root <dir>]
                                        # write a minimal app to <dir>/apps/<id>/ (installs nothing)
pnpm platform app compose <id|image-ref> --env prod|staging --out <file>
                                        # write the compose file that runs an external app (--help)
pnpm platform app remove <id> [--confirm <id>] [--yes]
                                        # back up the app's database, then remove the app
pnpm platform app purge <id> [--force] [--confirm <id>] [--yes]
                                        # drop a removed app's database and role (after its purge date)
pnpm platform app retention [--eligible]
                                        # removed apps with their backup and purge date
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

## Remove, purge and retention (`app remove`, `app purge`, `app retention`)

These call core-api's admin API (ADR 0001 §3 step 6; see `core/core-api/README.md`, "Remove and purge") with the
same `CORE_API_URL` and `CORE_API_ADMIN_TOKEN` as `app install` (locally they fall back to `.dev/core-api.env`).

**The id is always stated twice.** `remove` and `purge` take the app id as their argument and need it again before
anything is sent: typed at the prompt (`Type <id> to remove it`), or given as `--confirm <id>`. `--confirm` replaces
the prompt and is how a script runs them; without it, stdin must be a terminal, so a pipe or CI job without
`--confirm` is refused. `--yes` never stands in for the id: it is accepted only together with a matching
`--confirm <id>`. A typed or `--confirm` id that doesn't match, or no second statement at all, stops the command
before any request (exit 1). This is the same check as the Admin console's typed-id dialog.

- `app remove <id>` backs up the app's database (pg_dump on core-api's host) and removes the app. It prints the
  backup's path, size, the start of its sha256 and the purge date. `backup_failed` means nothing was removed.
- `app purge <id>` drops a removed app's database and its login role, and prints what was dropped (`dropped`, or
  `absent` when it was already gone). Before the purge date it is refused and the date is printed; `--force` purges
  before then (still with the id confirmed; core-api is sent `{ "force": true, "confirm": "<id>" }`). It is also
  refused when no backup was recorded (`no_backup`), the backup file is gone (`backup_missing`) or its sha256 has
  changed (`backup_mismatch`); each says so in plain words, and nothing is dropped.
- `app retention [--eligible]` lists removed apps as a table: when each was removed, its backup (size, sha256),
  its purge date and its status (`eligible`, `kept`, `no database`, `no backup (kept)` or `purged …`), then the
  backup paths. `--eligible` lists only the ones a purge would accept now. Nothing purges on its own: core-api has
  no scheduler.

## New app (`app new <id>`)

`app new` writes a minimal Next.js app to `<root>/apps/<id>/` from the files in `templates/app/`: a typed
manifest (`platform.app.ts`) and its compiled `platform.app.json`, a page that signs in through core/identity and
shows the launcher, `/health/live` and `/health/ready`, telemetry, and one test. Placeholders (`{{id}}`, `{{name}}`,
`{{glyph}}`, `{{port}}`) are replaced and a `.tmpl` suffix is dropped. The id is checked with the manifest schema's own
rules and an id that is reserved, already used under `apps/`, `external-apps/`, `core/`, `packages/` or `tools/`, or that is already the name of a workspace package (`@asafarim/<id>`) is refused. The folder is
written next to its place and renamed into it, so a failure leaves nothing behind. It only writes files: run
`pnpm install` and `pnpm platform sync` after it; installing in core-api (`app install`), the OIDC client and any
deploy stay separate steps. `--name` is the display name (default: the id in title case).

## Manifest review (`manifest review`)

ADR 0001 §10 item 2 (P7.2, part 1): it compares what each `apps/<id>/platform.app.json` declares with what the
app's code does. It reads files as text only and never runs app code. It is deterministic (no AI) and
**advisory**: it prints its findings and exits 0, and CI runs it that way. `--strict` exits 1 when there are
findings, `--json` prints them as JSON, and naming ids reviews only those apps.

| Finding                    | When                                                                                                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event-schema-missing`     | a `events.publishes` entry's schema file isn't in the app folder                                                                                                                                                                                                 |
| `event-schema-invalid`     | that file isn't JSON, or isn't a JSON object                                                                                                                                                                                                                     |
| `permission-never-checked` | a declared permission is named (as a whole string literal) by no runtime source file and by no manifest route                                                                                                                                                    |
| `route-unguarded`          | an `app/**/route.ts` method that no manifest route covers with a permission or `expose: false`, whose path isn't in `auth.publicPaths`, and where neither the handler nor any app file it imports (`@/…` or relative, transitively) names one of the permissions |

Runtime source means the app folder without `test/`, `e2e/`, `fixtures/`, `events/`, `node_modules/`, `.next/`,
`*.test.*`, `*.spec.*`, `*.d.ts` and the manifest itself. Auth.js's endpoints under `/api/auth/` and the SDK's
session hand-off (`createSessionHandler`) are sign-in plumbing, not findings. A text match can't prove a check runs
on every path, so `route-unguarded` reads "possibly". A fresh `app new` reports one finding: its placeholder
`<id>.read` permission, which the template declares but doesn't check yet.

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
