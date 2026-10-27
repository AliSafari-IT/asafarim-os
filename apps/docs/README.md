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

A document is rendered **on the server** (`components/Markdown.tsx`): GitHub-flavoured Markdown (tables, task lists), raw HTML never rendered and everything through `rehype-sanitize`'s default schema first. Then, in `lib/rehype.ts`: relative links resolve against the document and must stay inside the listing (a document opens in the app, an image goes through `/api/files`, anything else, or a path past the root, stays as plain text), external links get `rel="noopener noreferrer"`, and task-list checkboxes are named. Code is highlighted by shiki (GitHub's light and dark palettes, both in the HTML, the colour scheme picks one). A ` ```mermaid ` block is drawn in the browser by `components/Mermaid.tsx`, which imports mermaid only when a page has one, with `securityLevel: "strict"`; its source shows until then. It is drawn in the OS colours (Mermaid's `base` theme fed with `@asafarim/theme`'s tokens, redrawn when the theme changes) on a card. A wide diagram is shrunk to fit only down to 70 % of its natural size; past that it scrolls sideways inside its card (never the page, "Scroll sideways to see all of it."), and **Enlarge** opens it full screen at natural size, scrollable both ways. A `title:` in the diagram's front matter (or a `title` line) is what a screen reader hears.

Around it: the documents with readable names and a filter (a drawer on a phone), a breadcrumb, the owner badge, reading time and word count, "On this page" (h2 and h3, the current section marked) and ⌘K / Ctrl+K search over every title and heading (`GET /api/search`, gated; never the body). Titles, headings, reading time and issue links come from `@asafarim/markdown-utils` (`lib/outline.ts`), with heading ids that match the rendered ones.

With nothing open, the **home page** (`lib/home.ts`) shows a "Start here" card for the root `index.md` (else `README.md`), one card per top-level folder (its document count, its first four documents, "and N more"), and the other root documents; a document's folder is named next to it when two would read alike. Under every document, **Previous** and **Next** follow the sidebar's order. Both come from the listing alone: nothing more is fetched. Signed out, or without access, is a centred card that says nothing about the documents.

The browser check is `e2e/docs.spec.ts`, run by `pnpm e2e` after notes and admin: the roadmap fixture renders, every navigation lands in the right place, the drawer works, the home page's cards and Previous / Next open the right documents, and Lighthouse accessibility is at least 95 in light and dark, on the roadmap and on the home page (`test-results/lighthouse.json` and `lighthouse-home.json`, with screenshots in `test-results/screens/`).

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

## Events (Flow)

Docs publishes **`docs.note.created.v1`** (schema: [`events/docs.note.created.v1.json`](events/docs.note.created.v1.json): `id`, `author`, `docPath`, `tags`, `hasIssue`, `createdAt`). **Never the note's body or its quote**: notes are private, so a subscriber gets the note's tags and asks Docs for anything more. It's the trigger for ASafariM Flow (ADR 0001): writing `#issue` in a note starts a run that drafts a GitHub issue from it.

- **When:** on every new note, and on an edit that adds the tag `issue` (it wasn't there before the edit, it is after). Same type and fields; `createdAt` stays the note's creation time. Nothing on delete, on any other edit, or when the issue URL is saved.
- **Tags** (`lib/tags.ts`): `#word` in the note's Markdown, 1–40 letters, digits or hyphens, lower-cased, distinct in the order first seen, the first 10 only (so a `#issue` after ten other tags doesn't count). Not a tag: anything in fenced code or inline code, a URL or a link's destination, or a `#` that ends a word or a heading marker (`C#`, `a#b`, `##a`).
- `lib/notes.ts` writes the note and the event to the **outbox** in **one transaction** (an edit locks the row while it compares the tags before and after), so there is never a note without its event or an event without its note. The outbox relay (started in `instrumentation.ts`) sends it to the stream `APP_DOCS`, which core-api creates at install; the schema is uploaded for the Admin event catalog after registration. With the bus down, notes are still written; their events go out when it's back.

`test/tags.test.ts` covers the tag parser, `test/note-events.test.ts` when an event is written and what it carries (over a transactional stand-in for Postgres, `test/fake-db.ts`).

### Drafting an issue for Flow

Docs subscribes to **`flow.issue-draft.requested.v1`** (`{ runId, stepId, noteId, onBehalfOf }`) and answers with exactly one of:

- **`docs.issue-draft.ready.v1`** ([schema](events/docs.issue-draft.ready.v1.json)): `runId`, `stepId`, `requestId`, `noteId`, `docPath`, `repo` (owner/name), `public`, `title` (1–256), `body` (1–60 000), `labels` (at most 20, distinct).
- **`docs.issue-draft.failed.v1`** ([schema](events/docs.issue-draft.failed.v1.json)): `runId`, `stepId`, `requestId`, `noteId`, `code`, `message` (at most 1 000; never the note's text, a token or a stack trace).

`requestId` is always the id of the request event answered, so Flow drops a late answer to an earlier attempt. **Nothing is created on GitHub**: the owner approves the draft in Flow first.

`lib/subscribers.ts` starts the subscriber next to the relay (`instrumentation.ts`), only with a database and a bus; only that file loads the event SDK, never a page. The SDK's inbox runs the handler once per event id, in a transaction of Docs's database that also holds the answer's outbox row. The handler (`lib/issue-draft-handler.ts`), in order:

1. An invalid payload is logged and acked: never retried, never answered.
2. The note must be `onBehalfOf`'s: otherwise `note_not_found` (someone else's note reads as missing). It's read without a row lock; the transaction stays open during the AI call (up to 60 s).
3. `onBehalfOf` needs `docs.read` and `docs.issues.create`, asked from core-api every time: otherwise `forbidden`. If core-api can't answer (`AccessUnavailableError`) the handler throws, so the request is redelivered and nothing is answered.
4. A note that already has an issue: `issue_exists`.
5. The draft is built by the same code as "Generate GitHub issue" (`lib/issue-drafting.ts`, also used by `POST /api/notes/:id/issue/draft`): the repo that owns the document, its labels only, the validated AI answer, links to the reader replaced by the document's path.
6. Failures: GitHub's 401/403/404 is `no_repo_access`; an AI answer that fails validation, has no issue tool call, or grows past the event's limits once links are replaced is `invalid_ai_answer`; an AI timeout, network error, 429 or 5xx is `ai_unavailable`. Anything else (no `DOCS_ISSUES_TOKEN` or `DOCS_AI_API_KEY`, GitHub's 5xx, the AI's other 4xx, the document gone from the source) is thrown: redelivered with a backoff, then dead-lettered, and Flow's step keeps waiting.

`test/issue-draft-handler.test.ts` runs every branch through the SDK's delivery code over `test/fake-db.ts`, with GitHub and the AI mocked, and checks every answer against its schema.

### Creating the approved issue

Once the owner approves the draft in Flow, Docs gets **`flow.issue.approved.v1`** (`{ runId, stepId, approvalId, noteId, onBehalfOf, decidedBy, decidedAt, repo, title, body, labels, acknowledgedPublic }`, [Flow's schema](../flow/events/flow.issue.approved.v1.json)) and answers with exactly one of:

- **`docs.issue.created.v1`** ([schema](events/docs.issue.created.v1.json)): `runId`, `stepId`, `requestId`, `noteId`, `issueUrl`.
- **`docs.issue.failed.v1`** ([schema](events/docs.issue.failed.v1.json)): `runId`, `stepId`, `requestId`, `noteId`, `code`, `message` (at most 1 000). Nothing was created on GitHub.

The handler (`lib/issue-create-handler.ts`) runs in the inbox transaction like the draft's, in order:

1. An invalid payload is logged and acked: never retried, never answered.
2. The note must be `onBehalfOf`'s: otherwise `note_not_found`.
3. `onBehalfOf` needs `docs.read` and `docs.issues.create`, asked now: otherwise `forbidden` (so revoking the permission after the draft stops the issue). An outage is thrown and redelivered.
4. A note that already has an issue: `issue_exists`. Flow never confirms a second one.
5. Creating the issue is the same code as "Create issue" (`lib/issue-create.ts`, also used by `POST /api/notes/:id/issue`): a link to the reader is `invalid_issue` (checked first, without asking GitHub); the repo's visibility is asked **now**, and a public repo without `acknowledgedPublic: true` is `public_not_acknowledged`; a label the repo doesn't have is `invalid_issue`, naming it (the route drops such labels instead: its preview only offers the repo's own).
6. Failures: GitHub's 401/403/404 is `no_repo_access`, a 5xx or a timeout `github_unavailable`. Anything else, and a server without `DOCS_ISSUES_TOKEN`, is thrown: redelivered, then dead-lettered.

Then the issue's URL is saved on the note and `docs.issue.created.v1` published, in the inbox transaction. The note shows **via Flow** next to its issue link (an issue created from the note's own page clears it).

**No duplicate issue after a crash.** GitHub is outside the database's transaction, so the handler:

1. records `flow_approval_id` (and `flow_approval_at`) on the note in a write **committed on its own** (the pool, not the inbox transaction) before asking GitHub to create anything;
2. ends the issue's body with a hidden marker, `<!-- asafarim-flow:<approvalId> -->`;
3. on a redelivery that finds that approval recorded but no `issue_url`, first lists the issues the token's user opened in the repo since then (`GET /repos/{o}/{r}/issues?creator=…&since=…&state=all`, a few minutes earlier for clock skew; never the search API, whose index lags) and reuses the one with the marker. Only if there's none does it create the issue.

`test/issue-create-handler.test.ts` covers every branch and the crash (GitHub created the issue, the transaction failed at the answer, the URL or the commit, the event redelivered: one issue, its URL saved), over `test/fake-db.ts`, whose transactions apply their writes row by row at commit so the separately committed approval survives as in Postgres.

**In the e2e** (`pnpm e2e`, Flow's suite), GitHub and Claude are small local mock servers (`apps/flow/e2e/mocks.mjs`): Docs points at them through `DOCS_E2E_GITHUB_API_URL` and `DOCS_E2E_AI_API_URL`, which are honoured only for a loopback URL (`localhost`, `127.0.0.1`, `[::1]`), so a real token never goes to another host.

## Try it

```bash
pnpm dev                                         # installs and activates docs: http://docs.localhost:8080 (or localhost:4110)
pnpm platform role grant docs.owner dev-admin    # the owner role; nobody holds it by default
```

## Production (#83)

`docs.asafarim.site` runs the image `apps/docs/Dockerfile` builds (the "Docs image" workflow) as `os-docs` in the OS
production stack; `pnpm redeploy` on the VPS deploys the newest one. What it shows at each stage, its secrets
(`apps/docs/.env.production.age`) and the DNS record: [deploy/README.md](../../deploy/README.md#docsasafarimsite).

## Who gets in

Every page, route handler and server action goes through `lib/gate.ts`:

- **Not signed in:** the page answers `401` with the sign-in page; API routes answer `401` JSON; `/api/asafarim/session` redirects to sign-in.
- **Signed in without `docs.read`** (e.g. `dev-member`): a plain `403` "You don't have access" page naming `docs.read`, with no tree, titles or counts; API routes answer `403` naming it.
- **With `docs.owner`:** the documents.

`test/routes.test.ts` finds every route on disk, so a new one is checked without anyone remembering to. Every response sends `X-Robots-Tag: noindex, nofollow`, and `robots.txt` disallows everything. The session cookie is host-only (`__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`).
