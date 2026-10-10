# apps/docs

**Docs**, a private reader for documentation repositories on ASafariM OS (epic #76). The owner reads the Markdown of a docs repository, keeps study notes on parts of it, and turns a note into a GitHub issue in the repository that owns the document.

It follows the same steps as [`apps/notes`](../notes/README.md): install → register → sign in → an admin grants a role.

**The code is public; the documents are not.** Nothing from a docs repository is ever part of this code or its image. Which repository it reads is configuration (`source.repo`, `source.branch`), and documents are fetched at runtime with a read-only token.

| Permission           | What                            | Role         |
| -------------------- | ------------------------------- | ------------ |
| `docs.read`          | read the documents              | `docs.owner` |
| `docs.notes.write`   | write study notes               | `docs.owner` |
| `docs.issues.create` | turn a note into a GitHub issue | `docs.owner` |

Secrets (names only): `DOCS_GITHUB_TOKEN`, `DOCS_ISSUES_TOKEN`, `DOCS_AI_API_KEY`.

## Where the documents come from (#78)

`lib/source.ts` (server-only) reads the `.md` files and images of `source.repo` at `source.branch` **at runtime**: one Git Trees call lists every path, the Contents API reads one file. The tree is cached for 5 minutes and files are keyed by the tree's sha; **Refresh** drops the cache. Only paths in the listing can be read.

| `DOCS_GITHUB_TOKEN` | Where documents come from                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------ |
| set                 | GitHub (a fine-grained token: Contents read on the source repo only)                       |
| unset, development  | [`fixtures/`](fixtures/): made-up Markdown, so nobody needs access to a private repo       |
| unset, production   | nothing: the page says "Documents temporarily unavailable" (so does an unreachable GitHub) |

**Who owns a document** (for issues, #82): `docs-app.json` at the source repo's root lists `{ path, repo }` rules; the first matching glob wins, a document's front matter (`repo: owner/name`) overrides it, and with no match the source repo owns it. A broken file is shown as an error, and every document falls back to the source repo.

**Images** are served by `GET /api/files/<path>`, which checks `docs.read` first (never from `public/`); an SVG gets a CSP with `sandbox`, so it can't run script.

**Nothing is baked in:** `pnpm --filter @asafarim/docs check:no-content` builds the app (standalone) and fails if any fixture's marker text is under `.next/`. CI runs it.

## Try it

```bash
pnpm dev                                         # installs and activates docs: http://docs.localhost:8080 (or localhost:4110)
pnpm platform role grant docs.owner dev-admin    # the owner role; nobody holds it by default
```
