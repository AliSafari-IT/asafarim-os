# generated/platform/

Output of `pnpm platform:sync`, committed so reviews show exactly what changes. **Don't edit these files by hand.** Change the app's manifest and run the command again.

CI runs `pnpm platform:sync:check` and fails if this directory differs from what the manifests generate.

What's generated here:

- `launcher-registry.json`: the launcher tiles (`ui.launcher`).
- `gateway/dev.Caddyfile`: the **dev gateway** (P3.3a): one host per app (`<id>.localhost:8080`), `expose: false` paths → 404, and every other request checked by core-api before it is proxied. Its upstreams come from the environment (`OS_APP_<ID>_UPSTREAM`, `OS_CORE_API_UPSTREAM`, `OS_IDENTITY_UPSTREAM`), which `pnpm dev` writes to `.dev/gateway.env`.

The generators are listed in tools/platform-cli/README.md.
