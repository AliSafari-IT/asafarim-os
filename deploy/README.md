# Deploying the identity service (id.asafarim.site), the landing page (asafarim.site) and Docs (docs.asafarim.site)

The production stack of ASafariM OS: the identity service and its own Redis, since
[#70](https://github.com/AliSafari-IT/asafarim-os/issues/70) `os-site`, the static `asafarim.site` landing page
(`core/site`), and since [#83](https://github.com/AliSafari-IT/asafarim-os/issues/83) `os-docs`, the Docs app
(`apps/docs`) at `docs.asafarim.site`. It is part of P2.3
([#22](https://github.com/AliSafari-IT/asafarim-os/issues/22)). The landing page and Docs deploy **automatically** after
every green push to main ([Automatic deploy](#automatic-deploy)); identity's full deploy stays **by hand**. Nothing here
holds a plaintext secret.

| File                            | What it is                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy/compose.prod.yml`       | `identity`, `os-redis`, `os-site`, `os-docs`, `breinhap-site` and `igs-site`, compose project `asafarim-os`.                              |
| `deploy/vps-deploy.sh`          | The deploy. Run it from the repository folder on the VPS.                                                                                 |
| `deploy/redeploy.sh`            | `pnpm redeploy`: redeploy the landing page and docs with the newest builds, with no shas to look up.                                      |
| `deploy/ci-deploy.sh`           | The one command the Deploy workflow's SSH key may run (`deploy <sha>`), as a forced command. It hands over to `redeploy.sh <sha>`.        |
| `.github/workflows/deploy.yml`  | The Deploy workflow: after CI passes on main, wait for the images, then `deploy <sha>` over SSH.                                          |
| `deploy/lib/live-caddy.sh`      | `--site-only` before the edge cutover: install the site file for the Caddy that serves 443 today.                                         |
| `deploy/lib/env-check.sh`       | The check that every variable is filled, by name, never by value.                                                                         |
| `deploy/rollback.caddy`         | An empty site file: publishing it takes this stack's hosts off the edge.                                                                  |
| `sites/asafarim-os.caddy`       | This stack's site file: `id.asafarim.site` → `os-identity:3000`, `asafarim.site` → `os-site:8080`, `docs.asafarim.site` → `os-docs:3000`. |
| `sites/asafarim-os-site.caddy`  | The site-only file (`--site-only`): `asafarim.site` → `os-site:8080`, `docs.asafarim.site` → `os-docs:3000`, no `id.asafarim.site`.       |
| `apps/docs/.env.production.age` | `os-docs`'s secrets, encrypted (today `AUTH_SECRET` only). Decrypted on the VPS into `.env.docs` (mode 600, git-ignored).                 |
| `sites/asafarim-os-flow.caddy`  | `flow.asafarim.site` → `os-flow:3000`. Appended to the full site file **only** by a deploy with Flow ([below](#flowasafarimsite)).        |
| `apps/flow/.env.production.age` | **Not committed yet.** `os-flow`'s secrets; committing it is what turns Flow on. Decrypted on the VPS into `.env.flow`.                   |
| `deploy/flow/new-env.mjs`       | Writes `apps/flow/.env.production` (and identity's `IDENTITY_CLIENT_SECRET_FLOW`) with generated secrets.                                 |
| `deploy/nats/nats.conf`         | `os-nats`'s config: the auth callout and core-api's one login, no anonymous way in ([below](#the-event-bus-os-nats)).                     |
| `core/nats/.env.production.age` | **Not committed yet.** `os-nats`'s two values; committing it is what turns the bus on. Decrypted on the VPS into `.env.nats`.             |
| `deploy/nats/new-env.mjs`       | Writes `core/nats/.env.production` and core-api's side of the same login, with a generated key and password.                              |
| `deploy/identity/clients.json`  | **Not in git.** The client config you put there (below).                                                                                  |

## docs.asafarim.site

`os-docs` runs the Docs app (`apps/docs`): a private reader for a documentation repository. What it shows depends on
what is live around it:

| Live                                                                   | What `https://docs.asafarim.site` shows                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `os-docs` only (today, with `pnpm redeploy`)                           | The **sign-in page** ("Docs. A private reader for documentation."), to everyone. No document, title or count. Signing in does not work yet. |
| + identity (`id.asafarim.site`) with a `docs` client in `clients.json` | Sign-in works; a signed-in person gets an error page (no core-api to check `docs.read`), still no documents.                                |
| + core-api in production, Postgres and the app's tokens                | The documents, notes and issues, for whoever holds `docs.owner`.                                                                            |

`/api/health` answers `{"ok":true,"app":"docs"}` without a sign-in; every other path asks for one, and every response
carries `X-Robots-Tag: noindex, nofollow`. The documents are fetched from GitHub at runtime; none are in the image.

**Secrets.** `apps/docs/.env.production.age` holds `AUTH_SECRET` (a random session secret, encrypted to this
repository's key), the only one the sign-in page needs. The deploy decrypts it into `.env.docs` and checks every name
`apps/docs/.env.production.example` lists. The app's other secrets (`DOCS_GITHUB_TOKEN`, `DOCS_ISSUES_TOKEN`,
`DOCS_AI_API_KEY`, `DATABASE_URL`, and core-api's `CORE_API_URL` and `ASAFARIM_REGISTRY_CREDENTIAL`) are listed there,
commented out: to add one, `pnpm env:decrypt:production`, fill it in `apps/docs/.env.production`, uncomment it in the
example, `pnpm env:encrypt:production`, commit the `.age` file and redeploy.

**DNS.** Add an `A` record for `docs` in the `asafarim.site` zone, with the same address as the `asafarim.site` record
(the VPS), unless a wildcard `*` record already covers it. The edge's Caddy gets the certificate by itself once the
name resolves.

**Image.** The "Docs image" workflow builds `apps/docs/Dockerfile` (a Next.js standalone server, non-root, read-only
root) when `apps/docs`, `packages` or the lockfile change, and publishes `ghcr.io/alisafari-it/asafarim-os:docs-<sha>`.
Its build fails if any fixture text is in it.

## flow.asafarim.site

`os-flow` runs Flow (`apps/flow`): workflows across the OS apps, through events only. It is **off until the owner
commits `apps/flow/.env.production.age`**, the same gate as core-api's (asafarim-docs ADR 0001 Addendum I):

- **Without that file** a deploy is exactly what it was before: no `.env.flow`, no `flow` profile, no `os-flow`
  container, and the edge gets `sites/asafarim-os.caddy` byte for byte, with no `flow.asafarim.site` (a Caddy site for
  a host with no container would only turn today's TLS error into a 502). `deploy/vps-deploy.test.mjs` ("without
  apps/flow/.env.production.age: ...") proves it.
- **With it**, the full deploy (never `--site-only`) also needs core-api's env, decrypts it into `.env.flow`, checks
  the names `apps/flow/.env.production.example` lists (never the values), turns the `flow` profile on next to `core`,
  waits up to 60 seconds for `os-flow`'s `/health/ready`, and only then publishes `sites/asafarim-os.caddy` with
  `sites/asafarim-os-flow.caddy` appended (written to `.vps-deploy-site.caddy`, git-ignored). The edge's Caddy gets
  the certificate by itself. `deploy/redeploy.sh` (and so the automatic deploy) then also picks the newest "Flow
  image" and waits for it like the others.

`os-flow` is hardened like `os-docs` (read-only root, no capabilities, the `node` user, the manifest's 192 MB and
0.5 CPU, a healthcheck on `/health/live`), on `edge_net` as `os-flow` and on `os_core` with
`CORE_API_URL=http://os-core-api:4020`. Its database is on `os-postgres`, created by core-api's install like every
app's, never the platform's Postgres. `docs.url` is `https://docs.asafarim.site`. The image comes from the "Flow
image" workflow (`apps/flow/Dockerfile`), which smoke-tests it before publishing `flow-<sha>`.

> **Flow runs no workflow from Docs events unless the event bus is deployed.** Without the bus
> ([the next section](#the-event-bus-os-nats)) `ASAFARIM_NATS_URL` is empty: Flow starts, serves its pages and is
> healthy, and logs once that its subscribers (`flow.subscribers.no_bus`) and its outbox relay
> (`events.relay.no_bus`) are off. A `#issue` note in Docs starts nothing then. With the bus, the deploy gives Flow
> (and Docs and core-api) its address.

**For the owner, in order:**

1. **DNS.** `flow.asafarim.site` already resolves to the VPS; confirm it: `dig +short flow.asafarim.site` answers the
   same address as `dig +short asafarim.site`.
2. **The env file.** On your PC, in the repository: `pnpm env:decrypt:production` (identity's env must be there),
   then `node deploy/flow/new-env.mjs`. It writes `apps/flow/.env.production` (`AUTH_SECRET` and `OIDC_CLIENT_SECRET`,
   generated; mode 600), adds the same client secret to `core/identity/.env.production` as
   `IDENTITY_CLIENT_SECRET_FLOW`, prints only file names, and refuses to overwrite either. Then
   `pnpm env:encrypt:production` and commit **only** `apps/flow/.env.production.age` and
   `core/identity/.env.production.age`, on a branch, and merge them with a pull request. Never commit a decrypted env.
3. **The identity client.** Before merging, add the `flow` client to the VPS's `deploy/identity/clients.json` (not in
   git). Its secret is the `IDENTITY_CLIENT_SECRET_FLOW` of step 2, shared through identity's encrypted env:
   ```json
   {
     "client_id": "flow",
     "primary_domain": "flow.asafarim.site",
     "redirect_uris": ["https://flow.asafarim.site/api/auth/callback/asafarim"],
     "post_logout_redirect_uris": ["https://flow.asafarim.site/"],
     "client_secret_env": "IDENTITY_CLIENT_SECRET_FLOW"
   }
   ```
4. **After the automatic deploy** (identity and core-api run, so it is the full deploy, now with `os-flow`), on the VPS
   in `/var/repos/asafarim-os`:
   1. `deploy/core-api/admin.sh install flow`: it writes Flow's one-time credential and database URL to
      `.env.core-api-install-flow` (mode 600), never to the screen.
   2. Copy that file's two lines (`ASAFARIM_REGISTRY_CREDENTIAL`, `DATABASE_URL`) into `apps/flow/.env.production`
      (`pnpm env:decrypt:production` first), uncomment both names in `apps/flow/.env.production.example`,
      `pnpm env:encrypt:production`, and merge the `.age` file and the example with a pull request. The deploy
      restarts `os-flow` with them: it migrates its database and seeds its workflow.
   3. `deploy/core-api/admin.sh activate flow`. Flow registers on its next start (it retries), which creates its roles.
   4. `deploy/core-api/admin.sh grant flow.owner <account id>` (your id is on <https://id.asafarim.site/account>), or
      grant it in the Admin console. Permissions are cached for up to 60 seconds.
5. **Check:** `curl -fsS https://flow.asafarim.site/health/live` answers `{"ok":true,"app":"flow"}`; signing in at
   <https://flow.asafarim.site> shows the Overview.
6. **Rollback.** To take Flow off without touching the rest: revert the commit that added
   `apps/flow/.env.production.age` (a pull request) and let it deploy: the site file loses `flow.asafarim.site`, then
   stop the container on the VPS with
   `COMPOSE_PROFILES=core,flow IMAGE_TAG=rollback SITE_IMAGE_TAG=rollback DOCS_IMAGE_TAG=rollback CORE_API_IMAGE_TAG=rollback ADMIN_IMAGE_TAG=rollback FLOW_IMAGE_TAG=rollback docker compose -p asafarim-os -f deploy/compose.prod.yml rm -sf os-flow`.
   Flow's database on `os-postgres` stays. To run an **earlier Flow image** instead, deploy by hand with that image's
   commit as `vps-deploy.sh`'s seventh sha.

## The event bus (os-nats)

`os-nats` ([asafarim-os#259](https://github.com/AliSafari-IT/asafarim-os/issues/259), ADR 0001 §5) is the OS's event
bus: NATS with JetStream, as in development (`compose.dev.yml`), pinned to a minor line (`nats:2.11-alpine`). Apps
publish through their outbox relay and subscribe through consumers; core-api creates each app's stream at install. It
is **off until the owner commits `core/nats/.env.production.age`**, the same gate as core-api's and Flow's:

- **Without that file** a deploy is exactly what it was before: no `.env.nats`, no `nats` profile, no `os-nats`
  container. `deploy/vps-deploy.test.mjs` ("without core/nats/.env.production.age: ...") proves the same commands run
  in the same order, and the site file is byte for byte the same.
- **With it**, the full deploy (never `--site-only`) also needs core-api's env, decrypts it into `.env.nats`, checks the
  names `core/nats/.env.production.example` lists (never the values), turns the `nats` profile on next to `core`, and
  waits up to 60 seconds for the bus's `/healthz?js-enabled-only=true`. It publishes nothing on the edge and takes no
  image sha. `deploy/redeploy.sh` needs no change.
- **The bus's address.** Only when it runs `os-nats` does the deploy set `OS_NATS_URL=nats://os-nats:4222`, which
  compose hands to `os-core-api` (as `CORE_API_NATS_URL`) and to `os-docs` and `os-flow` (as `ASAFARIM_NATS_URL`). It
  first checks that core-api's env names its side of the login (`CORE_API_NATS_USER`, `CORE_API_NATS_PASSWORD`,
  `CORE_API_NATS_ISSUER_SEED`; names only) and stops before pulling if it does not. Without the bus the variable is
  unset, all three get an **empty** address and run without a bus, exactly as before (`deploy/vps-deploy.test.mjs`
  and `deploy/compose.prod.test.mjs` prove both cases). The login itself is a secret and stays in `.env.core-api`.

**Who can reach it.** `os-nats` is on `os_core` only, as `os-nats`, and publishes no port: only `os-core-api`, `os-docs`
and `os-flow` can open a connection, and nothing outside this host can. There is **no TLS**: the traffic never leaves
the host's private Docker network. **Anonymous clients are refused**: `deploy/nats/nats.conf` has no anonymous user, no
token and no other login than `core`. Every other client is sent to core-api's auth callout, which checks the app's
registry credential and grants only what its manifest allows (the same design as development). The two values the bus
holds are the callout issuer's **public** key and core-api's own password; the callout's signing key (the seed) stays in
core-api's env. A test fails if the config gains an anonymous way in.

`os-nats` is hardened like the other services (read-only root, no capabilities, `no-new-privileges`, a tmpfs `/tmp`),
with its store on the named volume `os_nats_data`, 128 MB and 0.25 CPU, and a healthcheck. **The 128 MB is a proposal**
(development uses 256): the OS stack's limits already add up to about 1.5 GB, so check the host first (step 1).

**For the owner, in order:**

1. **Memory.** On the VPS run `free -m` and share the "available" number. If the host cannot spare 128 MB, the limit
   changes before this is merged.
2. **The env file.** On your PC, in the repository: `pnpm env:decrypt:production` (core-api's env must be there), then
   `node deploy/nats/new-env.mjs`. It writes `core/nats/.env.production` (`NATS_AUTH_ISSUER`, the public key, and
   `NATS_CORE_PASSWORD`; mode 600) and adds core-api's side of the same login (`CORE_API_NATS_USER`,
   `CORE_API_NATS_PASSWORD`, `CORE_API_NATS_ISSUER_SEED`) to `core/core-api/.env.production`. core-api uses those three
   only when the deploy gives it the bus's address, so a deploy without the bus ignores them. The script prints only
   file names, and refuses to overwrite the bus's file or to run when core-api's env already names a `CORE_API_NATS_`
   variable. Then `pnpm env:encrypt:production` and commit **only** `core/nats/.env.production.age` and
   `core/core-api/.env.production.age`, on a branch, and merge them with a pull request. Never commit a decrypted env.
3. **After the automatic deploy** (identity and core-api run, so it is the full deploy, now with `os-nats`), on the VPS:
   `docker ps --filter name=os-nats --format '{{.Names}} {{.Status}}'` shows the container as `(healthy)`, and
   `docker logs --tail 20 $(docker ps -q --filter name=os-nats)` shows `Server is ready` and no secret. If the deploy
   stopped at "os-nats did not become ready", the same `docker logs` says why. Then:
   - core-api logs `bus.auth.serving` (it answers the bus's auth callout), and `bus.auth.granted` with `app` `docs` and
     `flow` once they connect. `bus.auth.refused` names the reason an app was turned away.
   - Docs and Flow are recreated by the same deploy (their environment changed). Their `events.relay.no_bus`,
     `flow.subscribers.no_bus` and `events.subscribers.not_started` warnings are gone.
   - **No reinstall is needed for an app that is already installed** (Docs, Flow). Every start registers the app with
     core-api, and registration runs the same idempotent steps as install: it creates the app's JetStream stream
     (`APP_<ID>`) if it publishes events, its consumers for the types it subscribes to, and the consumers of installed
     subscribers of what it publishes. If the bus is not ready yet, core-api answers `503 bus_unavailable` and the SDK
     retries with a backoff, so the order apps and bus come up in does not matter. The events Docs wrote to its outbox
     while there was no bus go out once its relay connects.
   - The end-to-end proof (a note in Docs reaches Flow; a handler that keeps failing ends in the `DEADLETTER` stream) is
     the staging check of asafarim-os#259. The same paths already run against the dev bus in CI (the "Event bus
     integration tests" step).
4. **Rollback.** To take the bus off without touching the rest: revert the commit that added
   `core/nats/.env.production.age` (a pull request) and let it deploy, then stop the container on the VPS with
   `COMPOSE_PROFILES=core,nats IMAGE_TAG=rollback SITE_IMAGE_TAG=rollback DOCS_IMAGE_TAG=rollback CORE_API_IMAGE_TAG=rollback ADMIN_IMAGE_TAG=rollback FLOW_IMAGE_TAG=rollback docker compose -p asafarim-os -f deploy/compose.prod.yml rm -sf os-nats`.
   The streams on the `os_nats_data` volume stay. The same deploy takes the address away from core-api, Docs and Flow
   (`OS_NATS_URL` is unset again), so they go back to running without a bus; nothing else needs reverting. Events Docs
   publishes meanwhile wait in its outbox.

## Landing page and docs (identity not running)

`deploy/vps-deploy.sh --site-only` ([#97](https://github.com/AliSafari-IT/asafarim-os/issues/97)) puts the
`asafarim.site` landing page and `docs.asafarim.site` live **without identity**: only the docs env is decrypted, and
nothing of identity's is checked, started or touched.

**Before you run it:**

- The repository is checked out on the VPS (normally `/var/repos/asafarim-os`). `age` is installed and `.age/key.txt`
  exists (mode 600): the docs env needs them. `identity_db` and `deploy/identity/clients.json` are not needed.
- The shared edge is installed (`/var/repos/edge/scripts/edge-deploy-site.sh` exists) and `edge_net` exists.
- The `os-site`, `os-docs`, `breinhap` and `igs-pharma-site` images can be pulled: the packages are public, or `docker login ghcr.io` was run
  on the VPS.
- The `docs` DNS record above exists (otherwise everything else works, and `docs.asafarim.site` gets its certificate
  once it does).
- `asafarim.site` and `www.asafarim.site` are no longer in asafarim-platform's `asafarim-com.caddy` **and**
  `infra/caddy/Caddyfile` (asafarim-platform#837, deployed). Until they are gone, the edge and the live Caddy refuse the
  duplicate hosts and keep their old config.
- **Before the edge cutover** (asafarim-platform #770 phase 3), the Caddy that serves 443 is asafarim-com's own. It must
  be on `edge_net` to reach `os-site`; the script says so, with the one command that fixes it, if it isn't. The
  asafarim-com checkout is at `/var/repos/asafarim-com` (or set `LIVE_REPO_DIR`).
- identity is **not** running in this stack. The site-only file has no `id.asafarim.site`, so the script refuses to
  run while identity runs (it would take identity off the edge). Use the full deploy then.

**Deploy the newest build (the usual way):**

```bash
cd /var/repos/asafarim-os
pnpm redeploy            # or, without pnpm on the VPS: deploy/redeploy.sh
curl -fsSI https://asafarim.site/
curl -fsS https://docs.asafarim.site/api/health
```

`deploy/redeploy.sh` finds the shas for you: `<commit>` is the newest commit on `origin/main`, and `<site-image-commit>` is
the newest commit that changed what the site image is built from (the same paths as the "Site image" workflow), because
that is the commit the newest image is tagged with; `<docs-image-commit>` is found the same way with the "Docs image"
workflow's paths. It checks both images are published and **stops if one isn't yet** (the
workflow may still be building), rather than quietly deploying an older one. Then it brings the checkout to `<commit>`
and runs `vps-deploy.sh --site-only` below. `pnpm redeploy --dry-run` only prints what it would deploy.

**Deploy a specific build** (for example, to roll back to an earlier image):

```bash
cd /var/repos/asafarim-os
deploy/vps-deploy.sh --site-only <commit> [<site-image-commit>] [<docs-image-commit>]
curl -fsSI https://asafarim.site/
```

- `<commit>`: a full 40-character sha on `origin/main` (the script, compose file and site file come from it).
- `<site-image-commit>`: the commit whose `os-site` image to run, default `<commit>`. Take the sha of the latest
  "Site image" run.
- `<docs-image-commit>`: the same for `os-docs` and the "Docs image" workflow, default `<commit>`.

It does steps 1, 2 and 3 for the docs env only, 4 (`edge_net` and the edge script only), 5 (`pull` and `up` for
`os-site` and `os-docs` only), 6 (`os-site`'s `/healthz`, up to 30 seconds, and `os-docs`'s `/api/health`, up to 60
seconds) and 7 below, and it publishes `sites/asafarim-os-site.caddy` under the same edge site
name, `asafarim-os`. A later full deploy simply replaces it with `sites/asafarim-os.caddy`.

Then, **before the edge cutover only**, step 8: the edge only stores the file, so the script also installs it as the
live Caddy's `infra/caddy/sites.local/asafarim-os.caddy` in the asafarim-com checkout (git-ignored there, and imported
by its `Caddyfile`), the way asafarim-platform's `igs-deploy.sh` does for igs-pharma.be: validate the whole live config
with the live Caddy's image, swap (keeping `.prev`), reload gracefully, and check the running Caddy reads this exact
file; any failure restores the previous file. After the cutover there is no asafarim-com Caddy and it does nothing.

**Rollback:** the same as a full deploy ([Rollback](#rollback)): publish `deploy/rollback.caddy`, then stop the stack.
Before the edge cutover, also take the file off the live Caddy first:

```bash
rm /var/repos/asafarim-com/infra/caddy/sites.local/asafarim-os.caddy
docker exec asafarim-com-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

To bring the old placeholder back, revert asafarim-platform#837 and redeploy asafarim-com.

## Automatic deploy

The **Deploy** workflow (`.github/workflows/deploy.yml`) runs `pnpm redeploy` for you, for one exact commit:

1. CI passes on a push to main. A pull request's run, a fork's, or a red or cancelled run never deploys. If main has
   already moved on, it does nothing: the newer commit deploys after its own CI, so an older commit never lands after a
   newer one. Only one deploy runs at a time.
2. It waits, up to 30 minutes, until the site and docs images that commit needs are published (the image workflows run
   alongside CI), using `deploy/redeploy.sh --dry-run <sha>` on the runner.
3. It connects to the VPS with its own SSH key and asks for `deploy <sha>`. On the VPS, `deploy/ci-deploy.sh` checks the
   sha is on `origin/main`, brings the checkout to it under the deploy lock, and runs `deploy/redeploy.sh <sha>`, which
   runs `vps-deploy.sh --site-only` (all its checks, health waits and the edge publish, as by hand).
4. It checks `https://asafarim.site/` answers. `docs.asafarim.site` only warns if it doesn't (DNS may not be set up yet).

It never starts identity. Once identity runs in this stack, `deploy/redeploy.sh` sees it and does the **full** deploy
instead (with the newest identity image, which must be published too), so a push to main keeps `id.asafarim.site` on the
edge. To put identity live the first time, run `deploy/redeploy.sh --with-identity` on the VPS (after "Before the first
deploy" below); add `--dry-run` first to see the shas it picks.

**Deploy or roll back by hand:** Actions → Deploy → Run workflow. Leave the commit empty for the newest commit on main,
or give an earlier full sha on main to roll back to it.

### Setup (once)

On the VPS, as the user that runs deploys today (it can run `docker`, owns `/var/repos/asafarim-os` and can read
`.age/key.txt`):

1. Create a key used for nothing else, with no passphrase:
   ```bash
   ssh-keygen -t ed25519 -N "" -C asafarim-os-deploy -f ~/asafarim-os-deploy
   ```
2. Allow it to run `ci-deploy.sh` and nothing else: add **one line** to `~/.ssh/authorized_keys`, the content of
   `~/asafarim-os-deploy.pub` after the options:
   ```text
   restrict,command="/var/repos/asafarim-os/deploy/ci-deploy.sh" ssh-ed25519 AAAA... asafarim-os-deploy
   ```
   `restrict` turns off port, agent and X11 forwarding and the terminal. Whatever the client asks, sshd runs that script,
   which accepts only `deploy <sha on origin/main>`.
3. Make sure the checkout has this commit's `deploy/ci-deploy.sh` (`git -C /var/repos/asafarim-os pull`, or the next
   `pnpm redeploy`).

In GitHub, Settings → Secrets and variables → Actions (or the `production` environment), add:

| Secret                  | Value                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `OS_DEPLOY_HOST`        | The VPS address.                                                                       |
| `OS_DEPLOY_USER`        | The user from step 1.                                                                  |
| `OS_DEPLOY_SSH_KEY`     | The **private** key: the whole of `~/asafarim-os-deploy`. Then delete it from the VPS. |
| `OS_DEPLOY_KNOWN_HOSTS` | The output of `ssh-keyscan -t ed25519 <host>`, checked against the VPS's own key.      |
| `OS_DEPLOY_PORT`        | Optional: the SSH port, if it isn't 22.                                                |

Until all four are set, the workflow stops before connecting and names the missing ones. To require an approval
before each deploy, add a protection rule to the `production` environment (Settings → Environments).

**To turn it off:** disable the Deploy workflow in Actions, or remove the key's line from `authorized_keys`.

## core-api (permissions for docs and the other apps)

`os-core-api` (the control plane, `core/core-api`) and `os-postgres` (the OS's own Postgres 16, never the platform's)
are the compose profile `core`. The full deploy starts them **once the commit has `core/core-api/.env.production.age`**;
without that file a deploy is what it was before. `deploy/redeploy.sh` then also picks the newest "Core API image" and
waits for it like the others.

**First time (the owner):**

1. On your PC, in the repository: `node deploy/core-api/new-env.mjs` writes `core/core-api/.env.production` with every
   value generated (it never prints one), then `pnpm env:encrypt:production`. Commit **only**
   `core/core-api/.env.production.age`, on a branch, and merge it with a pull request. The automatic deploy (identity
   runs, so it is the full deploy) starts `os-postgres` and `os-core-api` and waits for `/readyz`.
2. On the VPS, in `/var/repos/asafarim-os`: `deploy/core-api/admin.sh install docs`. It writes docs's one-time
   credential to `.env.core-api-install-docs` (mode 600), never to the screen.
3. Copy that file's lines into `apps/docs/.env.production` (`pnpm env:decrypt:production` first), re-encrypt, and merge
   the `.age` file with a pull request. The deploy restarts docs with its credential.
4. On the VPS: `deploy/core-api/admin.sh activate docs`. docs registers on its next start (it retries), which
   creates its roles. Then, with your account id from <https://id.asafarim.site/account>:
   `deploy/core-api/admin.sh grant docs.owner <account id>`. Permissions are cached for up to 60 seconds.

**Admin console (admin.asafarim.site, #175).** So that nobody needs SSH to grant roles, the console runs as `os-admin`
next to core-api. To turn it on: (1) add the `core-admin` client to `deploy/identity/clients.json` and
`IDENTITY_CLIENT_SECRET_ADMIN` to `core/identity/.env.production` (the client's JSON and the variables are in
[`core/admin/README.md`](../core/admin/README.md#in-production)); (2) create `core/admin/.env.production` from its
example (`AUTH_SECRET`, and `OIDC_CLIENT_SECRET` equal to `IDENTITY_CLIENT_SECRET_ADMIN`), then
`pnpm env:encrypt:production` and commit both `.age` files; (3) deploy that commit with `deploy/redeploy.sh` (the full
deploy, since identity runs: it starts `os-admin` and waits for its `/api/health`); (4) once, on the VPS:
`deploy/core-api/admin.sh grant core.admin <account id>`. Then grant everything else in the browser.

`deploy/core-api/admin.sh apps` and `grants <account id>` show the state. The admin token is read from `.env.core-api`
and never printed.

## breinhap.asafarim.site

`breinhap-site` serves the static landing page of Breinhap, an Android study app. Its source lives in the private
repository [AliSafari-IT/breinhap](https://github.com/AliSafari-IT/breinhap) (`apps/site`); that repository's "Site
image" workflow publishes `ghcr.io/alisafari-it/breinhap:site-<sha>` on every push to its main. This stack only runs
it: nginx-unprivileged on port 8080, read-only, no capabilities, 32 MB, on `edge_net` only. The Caddy blocks in both
site files are identical and carry the same strict CSP as the image's own nginx.

- **The image is pinned in `compose.prod.yml`**, not passed as a sha to the scripts, because its commits live in
  another repository. To ship a new version of the page: wait for the "Site image" run on breinhap's main, then open a
  PR here that replaces the sha in `image: ghcr.io/alisafari-it/breinhap:site-<sha>`. `compose.prod.test.mjs` fails
  unless it is a full 40-character sha. Once merged, the automatic deploy (or `pnpm redeploy`) pulls and starts it.
- **DNS**: an `A` record `breinhap` → `82.25.116.73` in the `asafarim.site` zone. Without it everything else works, and
  the edge gets the certificate once it exists.
- **Pull access**: the `breinhap` GHCR package is private by default. Make the package public (Package settings →
  Change visibility), or run `docker login ghcr.io` on the VPS with a token that has `read:packages`.
- The deploy waits up to 30 seconds for its `/healthz` after `os-site`'s, in both modes.

## igs.asafarim.site

`igs-site` serves the static landing page of IGS-Pharma, the online pharmacy being built for Belgium (its webshop and
Android app). Its source lives in [AliSafari-IT/igs-pharma](https://github.com/AliSafari-IT/igs-pharma) (`apps/site`);
that repository's "Landing page image" workflow publishes `ghcr.io/alisafari-it/igs-pharma-site:<sha>` on every push to
its main that touches `apps/site`. It runs exactly like `breinhap-site` (same limits, same Caddy block and CSP, on
`edge_net` only). The storefront itself (`igs-pharma.be`) is not part of this stack; it runs from asafarim-platform.

- **The image is pinned in `compose.prod.yml`**: to ship a new version of the page, wait for the "Landing page image"
  run on igs-pharma's main, then open a PR here that replaces the sha in
  `image: ghcr.io/alisafari-it/igs-pharma-site:<sha>`.
- **DNS**: an `A` record `igs` → `82.25.116.73` in the `asafarim.site` zone.
- **Pull access**: make the `igs-pharma-site` GHCR package public, or keep the VPS logged in to `ghcr.io`.
- The deploy waits up to 30 seconds for its `/healthz` after `breinhap-site`'s, in both modes.

## Networks: who can reach what

- **`edge_net`** (shared by every stack): `identity` under the unique alias **`os-identity`**, `os-site` (alias
  **`os-site`**, on no other network), `os-docs` (alias **`os-docs`**), `os-flow` (alias **`os-flow`**, only once Flow is deployed), `breinhap-site` (alias **`breinhap-site`**, on
  no other network) and `igs-site` (alias **`igs-site`**, on no other network). The edge's Caddy reaches them there. Redis,
  core-api and its Postgres are never on it.
- **`os_core`**: `os-core-api`, `os-postgres`, `os-nats` (only once the bus is deployed), `os-docs` and `os-flow` (the
  apps core-api serves). identity and `os-redis` are not on it.
- **`identity_db`**: `identity` and the platform's Postgres (alias `platform-postgres`), nothing else. Identity reads
  the platform database as the read-only `identity_ro` role. asafarim-platform's deploy creates this network.
- **`os_net`**: this stack's own private network, for `identity` and `os-redis`.
- Nothing publishes a port, except `os-core-api`'s admin API on the VPS's **loopback** (`127.0.0.1:4020`), for
  `deploy/core-api/admin.sh`. `deploy/compose.prod.test.mjs` fails if Redis lands on `edge_net`, or anything else
  publishes a port.

One thing to know: on `edge_net` the service name `identity` resolves too, not only the alias. Nothing else on
`edge_net` uses that name today; if another stack ever does, rename the service.

## Before the first deploy

On the VPS, in `/var/repos/asafarim-os`:

1. `.age/key.txt` exists (mode 600) and the `age` command is installed. The decryption key is yours.
2. The shared edge is installed (`/var/repos/edge/scripts/edge-deploy-site.sh` exists) and `edge_net` exists.
3. The asafarim-com stack has been deployed **with the `identity_db` change**: its `vps-deploy.sh` creates the network and
   puts `postgres` on it. (That deploy recreates the Postgres container once, because its network list changed.)
4. The identity, site and docs images are published (the "Identity image", "Site image" and "Docs image" workflows, [#44](https://github.com/AliSafari-IT/asafarim-os/issues/44))
   and the server can pull them: make the packages public, or run `docker login ghcr.io` on the server first.
5. `core/identity/.env.production.age` holds every variable in `core/identity/.env.production.example`.
6. `deploy/identity/clients.json` exists. For the **dark launch** it holds only the test client, never a real app:
   copy `core/identity/clients.example.json`, edit it, and set the client's secret in the env file under the name its
   `client_secret_env` gives. The file is git-ignored (Docker would create a _directory_ at the path if the file were
   missing, so the script refuses to start without it).
7. DNS: `id.asafarim.site` and `docs.asafarim.site` resolve to the VPS, and a `CAA` record allows Let's Encrypt. Caddy then gets the certificate
   by itself when the site is published.

## Deploy

```bash
cd /var/repos/asafarim-os
deploy/vps-deploy.sh <commit> [<image-commit>] [<site-image-commit>] [<docs-image-commit>]
```

- `<commit>`: the repository state to deploy, a **full 40-character sha** that is on `origin/main`.
- `<image-commit>`: the commit whose image to run. It defaults to `<commit>`. The image is built only when identity's
  inputs change, so the newest commit can have no image: take the sha from the latest "Identity image" run (its summary
  prints the exact `docker pull` line).
- `<site-image-commit>`: the same for the `os-site` image (the "Site image" workflow), default `<commit>`.
- `<docs-image-commit>`: the same for the `os-docs` image (the "Docs image" workflow), default `<commit>`.

### asafarim.site cutover (#70)

`asafarim.site` and `www.asafarim.site` are still served by asafarim-platform's `asafarim-com.caddy` until this stack
takes them over. In this order:

1. Remove the `asafarim.site` and `www.asafarim.site` blocks from `asafarim-com.caddy` and publish that file (the
   asafarim-com stack's own site deploy). The landing page is briefly unreachable from here.
2. Deploy this stack (`deploy/vps-deploy.sh`), with a `<site-image-commit>` that has a site image.

The edge validates the whole configuration before swapping a file in, so publishing this file while the other one
still defines `asafarim.site` fails safely and keeps the old config.

The script stops at the first failure and says why. In order:

1. fetch, refuse a commit that is not on `origin/main`, and `git reset --hard` to it;
2. decrypt `apps/docs/.env.production.age` into `.env.docs` and `core/identity/.env.production.age` into
   `.env.identity`, with plain `age` (mode 600);
3. check every variable each example lists is filled: it prints **names, never values**. For identity the list follows
   `IDENTITY_LOGIN_METHOD`: `hub` (the default) needs the example's Hub variables; `local` (or `sms`) needs
   `IDENTITY_OIDC_JWKS`, `IDENTITY_COOKIE_KEYS`, `IDENTITY_DATABASE_URL` and `IDENTITY_OTP_SECRET`, plus
   `IDENTITY_SMTP_HOST` and `IDENTITY_SMTP_FROM` for email codes (`IDENTITY_GOOGLE_CLIENT_ID` and `_SECRET` for Google, the Twilio variables for SMS), and no Hub variable;
4. check `identity_db`, `edge_net`, `deploy/identity/clients.json` and the edge script exist;
5. `docker compose pull`, then `up -d`;
6. wait up to 90 seconds for identity's `/readyz` (it checks Redis and the accounts database), then up to 30 seconds for
   `os-site`'s `/healthz` and up to 60 seconds for `os-docs`'s `/api/health`;
7. publish `sites/asafarim-os.caddy` with the edge's `edge-deploy-site.sh` (validate the whole edge config, swap, reload, verify).

Only step 7 makes the site reachable, and only if everything before it passed. If step 6 times out, the site is **not**
published; look at `docker compose -p asafarim-os -f deploy/compose.prod.yml logs --tail 50 identity` (identity logs ids,
codes and counts, never tokens or secrets).

Afterwards: `curl -fsS https://id.asafarim.site/.well-known/openid-configuration` answers 200 with issuer
`https://id.asafarim.site`, and `/jwks` is reachable.

> **Never run `docker compose config` on this host without `-q`.** It inlines the `env_file` values into its output,
> which would print the secrets. The script only uses `config -q`, and a test enforces it.

## Rollback

1. Take the site off the edge (this takes `asafarim.site` and `docs.asafarim.site` off too), with the edge's own script (it validates, swaps, reloads and verifies):
   ```bash
   /var/repos/edge/scripts/edge-deploy-site.sh asafarim-os deploy/rollback.caddy
   ```
2. Stop the stack. The tag only has to be non-empty here; `down` does not pull anything:
   ```bash
   COMPOSE_PROFILES=core IMAGE_TAG=rollback SITE_IMAGE_TAG=rollback DOCS_IMAGE_TAG=rollback CORE_API_IMAGE_TAG=rollback ADMIN_IMAGE_TAG=rollback FLOW_IMAGE_TAG=rollback docker compose -p asafarim-os -f deploy/compose.prod.yml down
   ```
   `COMPOSE_PROFILES=core` also stops `os-core-api` and `os-postgres` when they run (it needs `.env.core-api` to exist,
   which it does once core-api has been deployed; without core-api, leave `COMPOSE_PROFILES=core` out). Make it
   `core,admin`, `core,flow` and/or `core,nats` when the Admin console, Flow or the event bus runs (each needs its
   `.env.admin` / `.env.flow` / `.env.nats`).
3. **The volumes stay** (do not add `-v`): Redis's data in `os_redis_data`, the OS's Postgres in `os_pg_data` and
   core-api's backups in `os_core_api_backups` and the bus's streams in `os_nats_data` are kept, and `.env.identity`, `.env.docs` and `.env.core-api` stay on
   disk (mode 600; delete them yourself if you want them gone).

To go back to an **earlier image** instead, run the deploy again with that image's commit as `<image-commit>`.
To go forward again after a rollback, run the deploy again.

## What this does not do

- It adds no real app: only the test client of the dark launch is ever in `clients.json`.
- It does not touch Hub's environment. Hub's side of the hand-off is configured at its own deploy step (see #22 for the order).
- It creates no DNS record and no certificate by hand.
