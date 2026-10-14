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

| `DOCS_GITHUB_TOKEN`      | Where documents come from                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| set                      | GitHub (a fine-grained token: Contents read on the source repo only)                       |
| unset, `DOCS_SOURCE_DIR` | that folder (the e2e run points a production build at `fixtures/`)                         |
| unset, development       | [`fixtures/`](fixtures/): made-up Markdown, so nobody needs access to a private repo       |
| unset, production        | nothing: the page says "Documents temporarily unavailable" (so does an unreachable GitHub) |

**Who owns a document** (for issues, #82): `docs-app.json` at the source repo's root lists `{ path, repo }` rules; the first matching glob wins, a document's front matter (`repo: owner/name`) overrides it, and with no match the source repo owns it. A broken file is shown as an error, and every document falls back to the source repo.

**Images** are served by `GET /api/files/<path>`, which checks `docs.read` first (never from `public/`); an SVG gets a CSP with `sandbox`, so it can't run script.

**Nothing is baked in:** `pnpm --filter @asafarim/docs check:no-content` builds the app (standalone) and fails if any fixture's marker text is under `.next/`. CI runs it.

## Reading (#80)

A document is rendered **on the server** (`components/Markdown.tsx`): GitHub-flavoured Markdown (tables, task lists), raw HTML never rendered and everything through `rehype-sanitize`'s default schema first. Then, in `lib/rehype.ts`: relative links resolve against the document and must stay inside the listing (a document opens in the app, an image goes through `/api/files`, anything else, or a path past the root, stays as plain text), external links get `rel="noopener noreferrer"`, and task-list checkboxes are named. Code is highlighted by shiki (GitHub's light and dark palettes, both in the HTML, the colour scheme picks one). A ` ```mermaid ` block is drawn in the browser by `components/Mermaid.tsx`, which imports mermaid only when a page has one, with `securityLevel: "strict"`; its source shows until then.

Around it: the documents with readable names and a filter (a drawer on a phone), a breadcrumb, the owner badge, reading time and word count, "On this page" (h2 and h3, the current section marked) and ⌘K / Ctrl+K search over every title and heading (`GET /api/search`, gated; never the body). Titles, headings, reading time and issue links come from `@asafarim/markdown-utils` (`lib/outline.ts`), with heading ids that match the rendered ones.

The browser check is `e2e/docs.spec.ts`, run by `pnpm e2e` after notes and admin: the roadmap fixture renders, every navigation lands in the right place, the drawer works, and Lighthouse accessibility is at least 95 in light and dark (`test-results/lighthouse.json`, with screenshots in `test-results/screens/`).

## Study notes (#81)

While reading, select some text (or point at a heading) and choose **Add note**: a private note in Markdown, kept in the app's own Postgres database (`DATABASE_URL`, created by `platform app install`; the table is made by `lib/notes.ts` on first use, indexed on `(author, doc_path)`).

- **Anchoring.** A note keeps the heading id, the quoted text (plain text) and the version of the document it was written on (sha-256 of the Markdown); never line numbers. When the document changes, `lib/anchor.ts` looks for the quote again, whitespace ignored: in its own section, then anywhere. If it's gone, the note is kept under its heading (or at the top when the heading is gone too) and marked **text changed**.
- **Highlights** are drawn in the browser with the CSS Custom Highlight API over the page's text nodes: nothing is re-parsed or inserted. A quote that occurs more than once is highlighted at its first match after its heading. Clicking a highlight shows its note.
- **Notes are private and untrusted.** `GET /api/notes` needs `docs.read` and returns only the caller's own notes; `POST /api/notes`, `PATCH` and `DELETE /api/notes/:id` also need `docs.notes.write`, and every query is scoped to the author, so anyone else's note is "not found". Writes must be `application/json`. A note's body goes through the same Markdown pipeline as a document (sanitized first, no raw HTML); its quote is shown as text.
- **/notes** lists every note by document, filterable by document. Notes are edited and deleted on their document.
- **Generate GitHub issue** is shown next to **Add note** and on every note (#82, below).

## Generate GitHub issue (#82)

Two routes, both for `docs.issues.create` (after `docs.read`) on the caller's own note, JSON bodies only:

- `POST /api/notes/:id/issue/draft` (`{}` or `{ "repo": "owner/name" }`): builds the context (`lib/issue-context.ts`: the note, its quote, the section and its heading path, the title and outline, the section's issue links, the repo's labels; about 2 000 words at most, the outline is cut first), asks Claude for one forced `issue_draft` tool call (`ai.model`, 60 s timeout) and validates it with Zod (`lib/issue-draft.ts`: a title and the sections _Context_, _Problem / request_, _Suggested steps_, _Done when_). Returns the preview `{ repo, public, draft, labels, issueUrl }`. **Nothing is created on GitHub.**
- `POST /api/notes/:id/issue` (`{ repo, title, body, labels, confirm?, acknowledgedPublic? }`): creates the issue and saves its URL on the note. A note that already has an issue answers 409 `issue_exists` unless `confirm: true`. The repo's visibility is checked again at create time: a public repo answers 409 `public_not_acknowledged` (nothing is created) unless `acknowledgedPublic: true`, which the preview sends only when it showed the public-repo banner for that repo. If the repo turned public since the draft, the preview then shows the banner and **Create issue** asks again.
- Labels are only ever the target repo's existing ones. Links to the reader's own domain are replaced by the document's path in a draft and refused on create.
- Errors: 422 `no_repo_access` ("No access to owner/name") when the issues token can't reach the repo, 502 `invalid_ai_answer` for an answer that fails validation, 504 `ai_timeout`, 503 `issues_unavailable` without `DOCS_ISSUES_TOKEN` (both routes) or `DOCS_AI_API_KEY` (draft).
- Logs carry the note id, the repo's visibility, word counts and token usage, never the prompt, the note or the generated text. The AI and GitHub are called with `fetch` (`lib/issue-clients.ts`) and mocked in `test/issue.test.ts`.

**The preview** (`components/IssueDialog.tsx`): **Generate GitHub issue** on a note opens it (on a selection or a heading, the note is saved first). It asks for a draft, then shows the title, body (Markdown), the repo's labels as checkboxes and the target repo, all editable, with **Regenerate** and **Create issue**. A public repo shows a red banner ("This repo is public. Everything below will be visible to everyone."); `no_repo_access` shows "No access to owner/name" by the repo field; an error shows with **Try again**. The banner and labels are those of the repo the draft was made for: after typing another repo, **Regenerate** comes before **Create issue**. A note that already has an issue links to it and needs "Yes, create a second issue" ticked. Once created, the note (and `/notes`) shows **Issue created ✓** with the link. Without `docs.issues.create` the buttons are hidden; without `DOCS_AI_API_KEY` and `DOCS_ISSUES_TOKEN` they show disabled, "Not set up yet".

`e2e/notes.spec.ts` creates, edits and deletes notes, checks the "text changed" case and Lighthouse accessibility (light and dark, `test-results/lighthouse-notes.json`); `pnpm e2e` then restarts Docs and checks the notes are still there.

## Try it

```bash
pnpm dev                                         # installs and activates docs: http://docs.localhost:8080 (or localhost:4110)
pnpm platform role grant docs.owner dev-admin    # the owner role; nobody holds it by default
```

## Who gets in

Every page, route handler and server action goes through `lib/gate.ts`:

- **Not signed in:** the page answers `401` with the sign-in page; API routes answer `401` JSON; `/api/asafarim/session` redirects to sign-in.
- **Signed in without `docs.read`** (e.g. `dev-member`): a plain `403` "You don't have access" page naming `docs.read`, with no tree, titles or counts; API routes answer `403` naming it.
- **With `docs.owner`:** the documents.

`test/routes.test.ts` finds every route on disk, so a new one is checked without anyone remembering to. Every response sends `X-Robots-Tag: noindex, nofollow`, and `robots.txt` disallows everything. The session cookie is host-only (`__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`).
