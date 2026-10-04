# core/

Core services: the gateway config generator, `core-api` (registry, permissions, config, lifecycle), identity and the admin console.

Rule: nothing in `core/` imports from `apps/` or names a specific app. Apps talk to the core only through the platform SDK.

- [`identity/`](identity/): the OIDC provider for `id.asafarim.site`, with login delegated to Hub (ADR 0002, Addendum A).
- [`core-api/`](core-api/): the registry, permission catalog, lifecycle, the gateway's authorisation hook and the admin API.
- [`admin/`](admin/): the Admin console (apps, roles and grants, audit): an OIDC client of identity, built with the SDK.
