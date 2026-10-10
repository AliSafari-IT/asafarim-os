# apps/docs

**Docs**, a private reader for documentation repositories on ASafariM OS (epic #76). The owner reads the Markdown of a docs repository, keeps study notes on parts of it, and turns a note into a GitHub issue in the repository that owns the document.

This is the **scaffold** (#77): the manifest, sign-in, self-registration and an empty reading layout (file tree, document, table of contents). It follows the same steps as [`apps/notes`](../notes/README.md): install → register → sign in → an admin grants a role.

**The code is public; the documents are not.** Nothing from a docs repository is ever part of this code or its image. Which repository it reads is configuration (`source.repo`, `source.branch`), and documents are fetched at runtime with a read-only token.

| Permission           | What                            | Role         |
| -------------------- | ------------------------------- | ------------ |
| `docs.read`          | read the documents              | `docs.owner` |
| `docs.notes.write`   | write study notes               | `docs.owner` |
| `docs.issues.create` | turn a note into a GitHub issue | `docs.owner` |

Secrets (names only): `DOCS_GITHUB_TOKEN`, `DOCS_ISSUES_TOKEN`, `DOCS_AI_API_KEY`.

## Try it

```bash
pnpm dev                                         # installs and activates docs: http://docs.localhost:8080 (or localhost:4110)
pnpm platform role grant docs.owner dev-admin    # the owner role; nobody holds it by default
```
