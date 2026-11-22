# apps/knowledge

**ASafariM Knowledge** (`knowledge`): technical publishing and learning on ASafariM OS. This is **Phase 0** (#354), one working slice: authors write an article draft in the studio, publish a specific revision, anyone reads it, and the author can withdraw it. The design is in asafarim-docs, `ventures/asafarim-os/specs/ai-publishing-learning-platform.md`.

| Path                           | Who                                        | What                                                            |
| ------------------------------ | ------------------------------------------ | --------------------------------------------------------------- |
| `/`                            | anyone                                     | published articles, newest first                                |
| `/articles/<slug>`             | anyone                                     | one published article; anything else is a 404                   |
| `/studio`                      | `knowledge.content.create` (gateway + app) | your articles (every article for an editor), create             |
| `/studio/content/<id>`         | the owner, or an editor                    | edit and save the draft, publish a revision, withdraw           |
| `/studio/content/<id>/preview` | the owner, or an editor                    | the draft head (or `?rev=<n>`) as the public page would show it |
| `/studio/content/<id>/compare` | the owner, or an editor                    | `?from=&to=`: two revision numbers, `head`, or `autosave`       |

## Permissions and roles

| Permission                      | `knowledge.author` | `knowledge.editor` |
| ------------------------------- | :----------------: | :----------------: |
| `knowledge.content.create`      |         ✓          |         ✓          |
| `knowledge.content.edit.own`    |         ✓          |         ✓          |
| `knowledge.content.publish.own` |         ✓          |         ✓          |
| `knowledge.content.edit.any`    |                    |         ✓          |
| `knowledge.content.publish.any` |                    |         ✓          |
| `knowledge.taxonomy.manage`     |                    |         ✓          |

Publishing covers withdrawing. Roles are granted only by an admin; registering the app grants nothing. The gateway asks for `knowledge.content.create` on `/studio/**`, and every studio action asks again and checks ownership against the row it locks (`lib/policy.ts`, `lib/content.ts`). An article someone may not see is "not found" to them.

**Platform administrators as authors.** Every `core.admin` holder is eligible to write. The platform has no role mapping yet (an app sees only its own permissions, and core grants a role only on an admin's explicit action), so onboard them explicitly:

```bash
pnpm platform role holders core.admin
pnpm platform role grant knowledge.author <subject>   # for each holder; `role revoke` when they leave
```

A revoked role takes effect within the permission cache / access-token lifetime (60 s in production, 1 s in development).

## Content model

- `content_items`: owner, slug, a **draft head** (newest saved revision) and a **published revision** pointer (NULL = not public).
- `content_revisions`: immutable. Since #356 a revision is a **structured document** (`format = 'tiptap'`: Tiptap JSON in `doc`, validated and normalised by `lib/doc.ts`, with `schema_version`; `body` holds its plain text) or a Phase 0 **Markdown** body (`format = 'markdown'`). New articles start structured; a Markdown draft converts in the editor, which lists what the conversion drops (`lib/markdown-check.ts`). Structured bodies render on the server from the parsed document (`components/DocView.tsx`, Shiki for code), never from editor HTML. A trigger refuses UPDATE and DELETE. Each save adds one; a save carries the revision the editor opened and is refused with a conflict if someone saved since, with the author's text kept in the form.
- Publishing points the public pointer at one named revision of the same article (a composite foreign key keeps it inside the article). Later saves stay private until that revision is published. Withdrawing clears the pointer in the same transaction.
- `audit_events`: who created, saved, published, withdrew and moved what; ids only, never text.
- `draft_autosaves` (#372): the editor keeps the author's text a few seconds after they stop typing, one row per article and author, never a revision and never public. It records the revision the editor opened; if someone saved a newer one meanwhile, the autosave is still kept and the editor links a comparison instead of saving over it. Reopening the article offers to restore, compare or discard it. A save deletes it.
- `slug_redirects` (#372): changing the address of an article that has been public keeps the old address, pointing at the article (not at a slug), so `/articles/<old>` answers a permanent redirect (308) to the current address in one hop; redirects can't chain or cycle, a slug is never both an address and a redirect, and no other article can take an old address. Moving a public article needs the publish permission; a never-published draft just moves. A withdrawn article's old addresses are 404 like its current one.

The public pages read only through `published_revision_id`; there is no other query a guest reaches. Knowledge has no data path to the Docs app or any other app. Bodies are Markdown, rendered on the server with raw HTML dropped and `rehype-sanitize`. Studio responses are `private, no-store` and `noindex`.

## Topics, tags and search (#357)

- **Taxonomy.** Topics are a small hierarchy (top level plus one level). Tags are curated: editors (`knowledge.taxonomy.manage`) create them, of kind `subject` or `technology`, with aliases (`js` → `javascript`); authors pick existing tags by slug, name or alias, and an unknown tag is refused. An article has one topic, a level (beginner, intermediate, advanced) and up to 12 tags. Once an article has been public, changing its classification needs the publish permission, like its address.
- **Projection.** `search_documents` (+ `search_terms`, `search_sections`) holds one row per **published** article, rewritten by `lib/search-index.ts` inside the transaction that publishes, withdraws, moves or reclassifies it, and deleted on withdrawal. Search reads nothing else, so drafts and withdrawn articles can't appear.
- **Ranking** (`lib/search.ts`). Candidates come from weighted full text (`simple` configuration, so identifiers aren't stemmed; title A, tags and headings B, summary C, body D), exact identifiers (`useEffect`, `ERR_CONNECTION_RESET`, `C#`, stored lower-cased from code spans, code blocks and code-like words; `lib/identifiers.ts`), identifier prefixes, `pg_trgm` similarity of the title (misspellings) and tags the query names (aliases included). Facets (topic with its subtopics, tag, technology, level, language, kind) filter the candidates before ranking and paging; pages are keyset on (score, id). Each hit has a snippet from its best-matching section and a link to that heading.
- **Limits.** `/search` and `/api/public/search` allow 30 searches a minute per client (bursts of 10), in memory per process; past that, 429 with `Retry-After`. On a seeded 10 000-article set the p95 is about 165 ms, and that is the worst case: one query matching every article. The median is about 30 ms (`test/search.integration.test.ts`).
- The studio has its own authenticated search (`/studio?q=`): titles and slugs of the person's articles, drafts included.

Migrations are in `lib/migrations.ts` (versioned SQL under an advisory lock, recorded in `knowledge_migrations`). Never edit a shipped one: add the next.

## Run and test

```bash
pnpm dev                                   # installs and runs every app; Knowledge on http://localhost:4140
pnpm platform role grant knowledge.author dev-member
pnpm --filter @asafarim/knowledge test     # unit tests; with KNOWLEDGE_TEST_DATABASE_URL also the PostgreSQL ones
```

`KNOWLEDGE_TEST_DATABASE_URL` is an admin connection (locally `postgres://postgres:postgres-dev-only@127.0.0.1:55440/postgres`; CI sets its own). Each run creates and drops its own database.

Through the dev gateway: <http://knowledge.localhost:8080>. The address `learn.asafarim.site` in the manifest is proposed only: there is no production route, image or launcher tile yet.

## AI assistance (#360)

Studio authors with `knowledge.ai.use` (in `knowledge.author` and `knowledge.editor`) can ask for four **proposals**: an outline from a brief, a rewrite of the selection, a summary with title and tag ideas, and a Mermaid diagram from a description. A proposal is previewed first; the author applies it to the editor (or discards it) and saves as usual, so the AI never saves, overwrites or publishes, and an AI failure leaves the draft as it was.

- `lib/ai/provider.ts`: Anthropic's Messages API through the official SDK, `claude-opus-5-5` at effort `medium` by default, JSON answers constrained to a schema, one generation attempt per reservation (no retries or refusal fallback); each request reserves its input as counted by the token-counting endpoint (plus a 5% margin) and the operation's output limit. Off (the panel is hidden) without `KNOWLEDGE_AI_API_KEY`.
- `lib/ai/operations.ts`: the four operations, bounded inputs, author text marked as data in the prompt, answers validated into proposals (outlines through `lib/doc.ts`, diagrams through `checkMermaid`).
- `lib/ai/budget.ts`: monthly token caps for the publication (default 2 000 000) and per author (500 000), reserved before the call under row locks and settled to the reported usage.
- `ai_jobs` logs who, which operation, article, revision, outcome and tokens: never a prompt, selection or answer.

**Diagrams.** A `mermaid` node (source + text description) is edited in place with a live preview. Sources are checked (known diagram types, size limits, no `%%{init}` directives or front matter, no click/href, no HTML) and drawn in the browser with `securityLevel: "strict"`.

## Not in Phase 0

Courses, media and video, AI drafting and Mermaid proposals, events, scheduling, author profiles, SEO/RSS/LinkedIn, translations, production deployment. Each has its own issue.
