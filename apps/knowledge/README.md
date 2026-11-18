# apps/knowledge

**ASafariM Knowledge** (`knowledge`): technical publishing and learning on ASafariM OS. This is **Phase 0** (#354), one working slice: authors write an article draft in the studio, publish a specific revision, anyone reads it, and the author can withdraw it. The design is in asafarim-docs, `ventures/asafarim-os/specs/ai-publishing-learning-platform.md`.

| Path                   | Who                                        | What                                                  |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------- |
| `/`                    | anyone                                     | published articles, newest first                      |
| `/articles/<slug>`     | anyone                                     | one published article; anything else is a 404         |
| `/studio`              | `knowledge.content.create` (gateway + app) | your articles (every article for an editor), create   |
| `/studio/content/<id>` | the owner, or an editor                    | edit and save the draft, publish a revision, withdraw |

## Permissions and roles

| Permission                      | `knowledge.author` | `knowledge.editor` |
| ------------------------------- | :----------------: | :----------------: |
| `knowledge.content.create`      |         ✓          |         ✓          |
| `knowledge.content.edit.own`    |         ✓          |         ✓          |
| `knowledge.content.publish.own` |         ✓          |         ✓          |
| `knowledge.content.edit.any`    |                    |         ✓          |
| `knowledge.content.publish.any` |                    |         ✓          |

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
- `audit_events`: who created, saved, published and withdrew what; ids only, never text.

The public pages read only through `published_revision_id`; there is no other query a guest reaches. Knowledge has no data path to the Docs app or any other app. Bodies are Markdown, rendered on the server with raw HTML dropped and `rehype-sanitize`. Studio responses are `private, no-store` and `noindex`.

Migrations are in `lib/migrations.ts` (versioned SQL under an advisory lock, recorded in `knowledge_migrations`). Never edit a shipped one: add the next.

## Run and test

```bash
pnpm dev                                   # installs and runs every app; Knowledge on http://localhost:4140
pnpm platform role grant knowledge.author dev-member
pnpm --filter @asafarim/knowledge test     # unit tests; with KNOWLEDGE_TEST_DATABASE_URL also the PostgreSQL ones
```

`KNOWLEDGE_TEST_DATABASE_URL` is an admin connection (locally `postgres://postgres:postgres-dev-only@127.0.0.1:55440/postgres`; CI sets its own). Each run creates and drops its own database.

Through the dev gateway: <http://knowledge.localhost:8080>. The address `learn.asafarim.site` in the manifest is proposed only: there is no production route, image or launcher tile yet.

## Not in Phase 0

Structured (Tiptap) editing, taxonomy and search, courses, media and video, AI drafting and Mermaid proposals, events, slug redirects, scheduling, author profiles, SEO/RSS/LinkedIn, translations, production deployment. Each has its own issue.
