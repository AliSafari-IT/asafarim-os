# Deploying the identity service (id.asafarim.site)

The production stack of ASafariM OS: the identity service and its own Redis. It is part of P2.3
([#22](https://github.com/AliSafari-IT/asafarim-os/issues/22)), and **the owner deploys it by hand**: nothing in CI
runs it, and nothing here holds a secret.

| File                           | What it is                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `deploy/compose.prod.yml`      | `identity` and `os-redis`, compose project `asafarim-os`.                            |
| `deploy/vps-deploy.sh`         | The deploy. Run it from the repository folder on the VPS.                            |
| `deploy/lib/env-check.sh`      | The check that every variable is filled, by name, never by value.                    |
| `deploy/rollback.caddy`        | An empty site file: publishing it takes `id.asafarim.site` off the edge.             |
| `sites/asafarim-os.caddy`      | This stack's site file on the shared edge: `id.asafarim.site` to `os-identity:3000`. |
| `deploy/identity/clients.json` | **Not in git.** The client config you put there (below).                             |

## Networks: who can reach what

- **`edge_net`** (shared by every stack): `identity` only, under the unique alias **`os-identity`**. The edge's Caddy
  reaches it there. Redis is never on it.
- **`identity_db`**: `identity` and the platform's Postgres (alias `platform-postgres`), nothing else. Identity reads
  the platform database as the read-only `identity_ro` role. asafarim-platform's deploy creates this network.
- **`os_net`**: this stack's own private network, for `identity` and `os-redis`.
- Nothing publishes a port. `deploy/compose.prod.test.mjs` fails if Redis lands on `edge_net` or any port is published.

One thing to know: on `edge_net` the service name `identity` resolves too, not only the alias. Nothing else on
`edge_net` uses that name today; if another stack ever does, rename the service.

## Before the first deploy

On the VPS, in `/var/repos/asafarim-os`:

1. `.age/key.txt` exists (mode 600) and the `age` command is installed. The decryption key is yours.
2. The shared edge is installed (`/var/repos/edge/scripts/edge-deploy-site.sh` exists) and `edge_net` exists.
3. The asafarim-com stack has been deployed **with the `identity_db` change**: its `vps-deploy.sh` creates the network and
   puts `postgres` on it. (That deploy recreates the Postgres container once, because its network list changed.)
4. The identity image is published (the "Identity image" workflow, [#44](https://github.com/AliSafari-IT/asafarim-os/issues/44))
   and the server can pull it: make the package public, or run `docker login ghcr.io` on the server first.
5. `core/identity/.env.production.age` holds every variable in `core/identity/.env.production.example`.
6. `deploy/identity/clients.json` exists. For the **dark launch** it holds only the test client, never a real app:
   copy `core/identity/clients.example.json`, edit it, and set the client's secret in the env file under the name its
   `client_secret_env` gives. The file is git-ignored (Docker would create a _directory_ at the path if the file were
   missing, so the script refuses to start without it).
7. DNS: `id.asafarim.site` resolves to the VPS, and a `CAA` record allows Let's Encrypt. Caddy then gets the certificate
   by itself when the site is published.

## Deploy

```bash
cd /var/repos/asafarim-os
deploy/vps-deploy.sh <commit> [<image-commit>]
```

- `<commit>`: the repository state to deploy, a **full 40-character sha** that is on `origin/main`.
- `<image-commit>`: the commit whose image to run. It defaults to `<commit>`. The image is built only when identity's
  inputs change, so the newest commit can have no image: take the sha from the latest "Identity image" run (its summary
  prints the exact `docker pull` line).

The script stops at the first failure and says why. In order:

1. fetch, refuse a commit that is not on `origin/main`, and `git reset --hard` to it;
2. decrypt `core/identity/.env.production.age` with plain `age` into `.env.identity` (mode 600);
3. check every variable the example lists is filled: it prints **names, never values**;
4. check `identity_db`, `edge_net`, `deploy/identity/clients.json` and the edge script exist;
5. `docker compose pull`, then `up -d`;
6. wait up to 90 seconds for identity's `/readyz` (it checks Redis and the accounts database);
7. publish `sites/asafarim-os.caddy` with the edge's `edge-deploy-site.sh` (validate the whole edge config, swap, reload, verify).

Only step 7 makes the site reachable, and only if everything before it passed. If step 6 times out, the site is **not**
published; look at `docker compose -p asafarim-os -f deploy/compose.prod.yml logs --tail 50 identity` (identity logs ids,
codes and counts, never tokens or secrets).

Afterwards: `curl -fsS https://id.asafarim.site/.well-known/openid-configuration` answers 200 with issuer
`https://id.asafarim.site`, and `/jwks` is reachable.

> **Never run `docker compose config` on this host without `-q`.** It inlines the `env_file` values into its output,
> which would print the secrets. The script only uses `config -q`, and a test enforces it.

## Rollback

1. Take the site off the edge, with the edge's own script (it validates, swaps, reloads and verifies):
   ```bash
   /var/repos/edge/scripts/edge-deploy-site.sh asafarim-os deploy/rollback.caddy
   ```
2. Stop the stack. The tag only has to be non-empty here; `down` does not pull anything:
   ```bash
   IMAGE_TAG=rollback docker compose -p asafarim-os -f deploy/compose.prod.yml down
   ```
3. **The volumes stay** (do not add `-v`): Redis's data in `os_redis_data` is kept, and `.env.identity` stays on disk
   (mode 600; delete it yourself if you want it gone).

To go back to an **earlier image** instead, run the deploy again with that image's commit as `<image-commit>`.
To go forward again after a rollback, run the deploy again.

## What this does not do

- It adds no real app: only the test client of the dark launch is ever in `clients.json`.
- It does not touch Hub's environment. Hub's side of the hand-off is configured at its own deploy step (see #22 for the order).
- It creates no DNS record, no certificate by hand, and no secret.
