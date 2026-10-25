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
pnpm platform app list [--json]
                                        # every app core-api knows, with its state; read-only
pnpm platform app show <id> [--json]
                                        # one app: version, state, its permissions and roles; read-only
pnpm platform app remove <id> [--confirm <id>] [--yes]
                                        # back up the app's database, then remove the app
pnpm platform app purge <id> [--force] [--confirm <id>] [--yes]
                                        # drop a removed app's database and role (after its purge date)
pnpm platform app retention [--eligible] [--verify]
                                        # removed apps with their backup and purge date
                                        # (--verify: check each listed backup's sha256 now; exit 1 unless all ok)
pnpm platform role list [--app <id>] [--json]
                                        # every declared role with its holders and permissions; read-only
pnpm platform role holders <role> [--json]
                                        # who holds a role; read-only
pnpm platform role held-by <subject> [--json]
                                        # every role a person (identity sub) holds; read-only
pnpm platform status [--alerts] [--json]
                                        # core-api's status board (and alert history); read-only
pnpm platform audit [--app <id>] [--actor <text>] [--limit <n>] [--before <id>] [--json]
                                        # core-api's audit log, newest first; read-only
pnpm platform events [--app <id>] [--json]
                                        # the event catalog: publisher, schema status, subscribers; read-only
pnpm platform events schema <type>
                                        # the JSON schema a type's publisher uploaded; read-only
pnpm platform events search <words> [--app <id>] [--json]
                                        # Admin's keyword search over the catalog, best first; read-only
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
- `app retention --verify` asks core-api to check each listed backup file against its sha256 now
  (`GET /admin/v1/retention?verify=true`), purged apps included, since after a purge the backup is the only copy of
  the data. With `--eligible`, only the eligible entries are listed, so only their backups are checked; run it
  without `--eligible` to check them all. A Check column shows `ok`, `missing`, `mismatch` or `unreadable` (`–` without a
  backup), and a line names each backup that failed. It exits 1 unless every listed backup is `ok`, so a cron job
  or a script can alert on it. Read-only; core-api hashes one file at a time, so a large backup takes a moment.

## Status board and alerts (`status`)

`status` prints core-api's status board (`GET /admin/v1/status`, the same data as Admin's Status page): one row per
entry (core-api itself and every installed app) with its lifecycle state, live and ready, the slower check's
latency, when it was checked and, when a check failed, its error class and detail (an HTTP status or a core-api
check name). Apps that aren't active are listed as `not polled`. `--alerts` adds the alert history
(`GET /admin/v1/alerts`): the last down/recovered transitions, newest first, and whether core-api sends them to a
webhook (never its URL). `--json` prints core-api's replies unchanged, as `{ "status": … }`, or `{ "status": …, "alerts": … }` with `--alerts`.

It uses the same `CORE_API_URL` and `CORE_API_ADMIN_TOKEN` as `app install`, and only reads. The exit code is 0
when core-api has finished a health round and every polled entry is live and ready, otherwise 1 (also when
core-api can't be reached or refuses the token), so a script can wait on it. Text that comes from app manifests is
printed with control characters replaced.

## Audit log (`audit`)

`audit` prints core-api's audit log (`GET /admin/v1/audit`, the same data as Admin's Audit page), newest first:
one row per event with its id, time, actor, action, app (`–` for none) and its detail as compact JSON, cut at 80
characters. `--app <id>` keeps one app's events, `--actor <text>` keeps actors containing that text (any case),
`--limit <n>` takes 1–200 events (core-api's default is 50), and `--before <id>` starts below that event id. When
there are older events, the last line is the command for the next page, with the same filters. `--json` prints
core-api's reply unchanged (`{ "events": […], "next": <id> | null }`), details in full.

It uses the same `CORE_API_URL` and `CORE_API_ADMIN_TOKEN` as `status`, and only reads. It exits 0 when core-api
answered, and 1 when it can't be reached, refuses or answers with something else. Control characters in the text are
replaced.

## App list (`app list`)

`app list` prints every app core-api knows (`GET /admin/v1/apps`, the same data as Admin's Apps page): core first,
then installed apps by id, then removed ones. One row per app with its id, name, version, state (`(system)` for
core, which can't be deactivated or removed), when it was installed, and its role and permission counts. Below the
table, an app that subscribes to events no installed app publishes gets a warning line (nothing is blocked), and a
removed app gets a line with its removal and purge date (`app retention` has the backup details). `--json` prints
core-api's reply unchanged (`{ "apps": […] }`).

It uses the same `CORE_API_URL` and `CORE_API_ADMIN_TOKEN` as `status`, and only reads. It exits 0 when core-api
answered, and 1 when it can't be reached, refuses or answers with something else. Control characters in the text are
replaced.

## One app (`app show`)

`app show <id>` prints one app as core-api records it (`GET /admin/v1/apps/<id>`): its version, state, when it was
installed and when it first registered ("not yet" until it has), then every permission it declares (key and
description) and every role. A permission or role the app no longer declares, kept while a role or grant still uses
it, is marked "deprecated" with its date. A removed app gets a pointer to `app retention`. The id is checked with
core-api's pattern before any request. `--json` prints core-api's reply unchanged.

Like `app list` it uses `CORE_API_URL` and `CORE_API_ADMIN_TOKEN` and only reads. It exits 1 when core-api can't be
reached, refuses, has no such app (`core-api has no app "<id>".`), or answers with something else. Control
characters in the text are replaced.

## Roles and grants (`role list`, `role holders`, `role held-by`)

`role grant|revoke` changes who holds an app's declared role; these three only read, the same data as Admin's Roles
and People pages:

- `role list [--app <id>]` (`GET /admin/v1/roles`): one row per role with its app, number of holders, number of
  permissions and description. Below the table, a deprecated role (the app no longer declares it, kept while someone
  holds it) and a role that still grants a permission the app no longer declares (ADR 0001 §3.4) each get a line.
- `role holders <role>` (`GET /admin/v1/roles/<role>/grants`): who holds it, when it was granted and by whom.
  core-api answers an empty list for a role it doesn't know, so "Nobody holds …" also covers a typo.
- `role held-by <subject>` (`GET /admin/v1/subjects/<sub>/grants`): every role one person (their identity `sub`)
  holds, across apps.

The role and subject are checked with core-api's own rules before anything is asked. `--json` prints core-api's
reply unchanged. They use the same `CORE_API_URL` and `CORE_API_ADMIN_TOKEN` as `status`. They exit 0 when core-api
answered, and 1 when it can't be reached, refuses or answers with something else. Control characters in the text
are replaced.

## New app (`app new <id>`)

`app new` writes a minimal Next.js app to `<root>/apps/<id>/` from the files in `templates/app/`: a typed
manifest (`platform.app.ts`) and its compiled `platform.app.json`, a page that signs in through core/identity and
shows the launcher and, to people holding `<id>.read`, the app; a guarded example route (`/api/hello`, through
`lib/gate.ts`), `/health/live` and `/health/ready`, telemetry (flushed on shutdown), and one test. A fresh scaffold
passes `manifest review --strict`. Placeholders (`{{id}}`, `{{name}}`,
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

| Finding                     | When                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `event-schema-missing`      | a `events.publishes` entry's schema file isn't in the app folder                                                                                                                                                                                                                                                                                             |
| `event-schema-invalid`      | that file isn't JSON, or isn't a JSON object                                                                                                                                                                                                                                                                                                                 |
| `event-schema-uncompilable` | that JSON object doesn't compile with the publisher's ajv setup (`compileEventSchema`: JSON Schema 2020-12, strict, ajv-formats), so `createPublisher` throws at start-up and core-api refuses the schema upload                                                                                                                                             |
| `permission-never-checked`  | a declared permission is named (as a whole string literal) by no runtime source file and by no manifest route                                                                                                                                                                                                                                                |
| `route-unguarded`           | an `app/**/route.ts` method that no manifest route covers with a permission or `expose: false`, whose path isn't in `auth.publicPaths`, and where neither the handler nor any app file it imports (`@/…` or relative, transitively) names one of the permissions                                                                                             |
| `event-not-declared`        | a runtime source file names an event type in the app's own namespace (`<id>.<entity>.<verb>.v<N>`, as a whole string literal) that `events.publishes` and `events.subscribes` don't list (P7.2 part 2a)                                                                                                                                                      |
| `event-handler-missing`     | an `events.subscribes` entry whose `handler` path no `app/**/route.ts` serves, and whose type no runtime source file names (P7.2 part 2a)                                                                                                                                                                                                                    |
| `permission-not-declared`   | a runtime source file passes a key in the app's own namespace, as a whole string literal, as the first or second argument of a permission check (`gate`, `require`, `can`, …, or `includes`/`has` on a permission or role collection; comments don't count), and the manifest declares it neither as a permission nor as a role, so the check always refuses |

Runtime source means the app folder without `test/`, `e2e/`, `fixtures/`, the root `events/` (schemas), `node_modules/`, `.next/`,
`*.test.*`, `*.spec.*`, `*.d.ts` and the manifest itself. Auth.js's endpoints under `/api/auth/` and the SDK's
session hand-off (`createSessionHandler`) are sign-in plumbing, not findings. A text match can't prove a check runs
on every path, so `route-unguarded` reads "possibly". A fresh `app new` reports no findings.

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
