# @asafarim/engagement — session start (resume here)

Read this first when you pick the work up in a new session or on another account. Then read
`git log --oneline -15` on the work branch and run the checks in "Verify before continuing".

- Status (2026-11-27): Phases 1–4 done (#397, #399, then the Phase 4 PR).
- Repo: `AliSafari-IT/asafarim-os` (the OS). Not `asafarim-platform` (a different, Next.js/Prisma monorepo;
  nothing was changed there for this work).
- Work branch: `claude/serene-darwin-1d44kb` (push there; open a **draft** PR into `main`; `main` takes no direct pushes).
- Owner preferences: before each action, state a short **title + precise description** of what you are about to do,
  then do it. Replies in English. Be careful with code ("wees voorzichtig met code").

## Goal

A reusable, self-contained **Engagement module** (likes + comments) as `packages/engagement` (`@asafarim/engagement`),
mounted by each app into **its own isolated Postgres** (no separate microservice, no cross-app joins).
First host: `apps/knowledge` (lessons → modules → courses rollups). Later: `apps/notes`, blog, …

Full original brief is summarised in "Spec" below; the phase checklist is the source of truth for progress.

## Verified facts about this repo (they differ from the original brief — trust these)

| Brief says                          | Reality in asafarim-os                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Express/Node router                 | Apps are **Next.js 16** (App Router). Server code = route handlers (Web `Request`/`Response`). The package therefore exposes **framework-agnostic handlers** + a small router, not Express.                                                                                                                                              |
| `apps/knowledge/manifest.json`      | The manifest is `apps/knowledge/platform.app.ts` (`defineApp`, schema in `packages/app-manifest/src/schema.ts`); `platform.app.json` is generated beside it. Never edit `generated/platform/**` by hand.                                                                                                                                 |
| Route `permission: null` for public | Public paths are `auth.publicPaths`; `routes[]` only lists **gated** paths (`path`, `methods`, `permission`). A route's permission must be declared in `permissions` and be in the app's namespace (`knowledge.*`).                                                                                                                      |
| Query builder                       | Raw **`pg`** (`pg.Pool`, `lib/db.ts`), hand-written SQL migrations in `lib/migrations.ts` (numbered, recorded in `knowledge_migrations`, one advisory lock). No ORM.                                                                                                                                                                     |
| `core/identity` + Redis             | Redis 7 is used only by `core/identity` and `packages/auth-runtime` (`ioredis`); dev URL `redis://127.0.0.1:56380/<db>`. Knowledge has **no** Redis today and an in-memory token bucket (`apps/knowledge/lib/rate-limit.ts`).                                                                                                            |
| Client IP                           | The gateway (Caddy) **appends** the real client address as the **last** `X-Forwarded-For` entry; entries to its left are client-supplied and forgeable. Use the LAST entry (see `clientKey` in knowledge's `lib/rate-limit.ts`).                                                                                                         |
| Event bus                           | Events are `<app>.<noun>.<verb>.v1`, published with `createPublisher(...).publish(tx, type, data, {subject})` **inside your transaction** (outbox → JetStream). Schemas are declared in the manifest. So the event is `knowledge.comment.created.v1`.                                                                                    |
| `pnpm platform:sync`                | Exists (`pnpm platform:sync` / `platform:sync:check`).                                                                                                                                                                                                                                                                                   |
| `pnpm env:check`                    | Exists (`scripts/check-env-safety.mjs`): fails if `.dev/**` or a decrypted `.env*` is tracked.                                                                                                                                                                                                                                           |
| Knowledge data model                | `courses` is mutable, but **`course_revisions`, `course_modules`, `course_lessons` are immutable (DB triggers block UPDATE/DELETE)**; a course edit makes a new revision. Lesson id (`lesson_id`) is stable across revisions; a module has **no stable id** (`(revision_id, position)`). All ids are `text`. See "Open design question". |
| Engines                             | `node >=24`, pnpm 12. The cloud sandbox had node 22 (works for tests).                                                                                                                                                                                                                                                                   |

## Design decisions already taken (Phase 1)

1. `entity_id` and `user_id` are **`text`**, not `uuid`: the OIDC `sub` and Knowledge's ids are text. Comment `id` is `uuid` (`gen_random_uuid()`).
2. Visitor hash = **HMAC-SHA-256**(key = `ENGAGEMENT_SALT`, message = `lastForwardedFor \n userAgent`) as 64 hex chars. Same shape as the brief's salted SHA-256, but a proper keyed construction. Salt is required (>= 16 chars); missing salt throws (fail closed).
3. Likes: exactly one of `user_id` / `visitor_hash` is set (CHECK). Partial unique indexes per the brief. Toggle = `INSERT … ON CONFLICT DO NOTHING RETURNING` else `DELETE … RETURNING`; the rollup `delta` is applied **only when a row was really inserted/deleted**, so races cannot double-count.
4. Comments: depth limited to 1 by a trigger (parent must be top-level and on the same entity); body 1..2000 chars; `ON DELETE CASCADE` for replies; `deleteComment` is a hard delete and reports `delta = -(visible rows removed)`. `comments_count` counts **visible** comments (top-level + replies).
5. `onCountChange(entityType, entityId, metric, delta, tx)` runs **inside the same transaction** as the like/comment write; if it throws, everything rolls back.
6. Rate limit: Redis sliding-window log (sorted set + one atomic Lua script), 15/min/IP on `likes/toggle`. Redis is **injected** through a minimal `RedisLike` (`eval(script, numKeys, ...args)`, which `ioredis` satisfies) so the package has no hard Redis dependency; an in-memory limiter with the same contract is provided for dev/tests. On Redis failure the default is **fail-open + warn** (DB unique constraints still prevent duplicate likes); configurable.
7. Entity allow-list: handlers only accept `entityType`s the app registers (and may verify the entity exists) so nobody can write rows for arbitrary types/ids.

## Rollup design (decided by the owner, implemented in Phase 3)

Knowledge has no mutable `lessons`/`modules` table and revisions are immutable by trigger, so (owner's OK, 2026-11-27):
`courses.likes_count/comments_count` are real columns on the mutable `courses` table, and one mutable table
`engagement_rollups(entity_type 'lesson'|'module', entity_id, likes_count, comments_count)` holds lesson counts
(`lesson_id`) and module counts (`<courseId>:<modulePosition>`). See `apps/knowledge/lib/engagement-rollups.ts`.

Invariant: module and course counts = the sums of the lesson counts of the lessons in the course's **published**
revision. `applyCountChange` (the `onCountChange` hook) keeps it per like/comment; `recountCourseEngagement` restores it
inside `publishCourse` (lessons moved/added/removed). Every write to a course's rollups holds the course row lock
(`SELECT … FOR UPDATE`), so a like and a publish cannot interleave. A withdrawn course only updates lesson counts; the
next publish recounts.

## Version rules (owner's instruction)

Bump every package you change: a `0.1.x` version becomes **`0.2.0`**; any other `x.y.z` gets **+0.1.0** (e.g. `0.4.3 → 0.5.0`). A brand-new package starts at `0.1.0`. Keep `package.json`, `platform.app.ts` and the generated `platform.app.json` of an app in sync (knowledge is `0.1.10` → `0.2.0` when Phase 3 touches it).

## Phase checklist

Legend: [x] done, [~] in progress, [ ] todo. (Update this list in every commit that moves work.)

### Phase 1 — core package (DONE; 58 tests green with real Postgres 16 + Redis 7)

- [x] Scaffold `packages/engagement` (package.json, tsconfig, tsconfig.build, eslint); workspace glob `packages/*` already covers it; `ENGAGEMENT_TEST_DATABASE_URL` / `ENGAGEMENT_TEST_REDIS_URL` added to `turbo.json` `test.passThroughEnv`.
- [x] Migrations for `engagement_likes` + `engagement_comments` (`src/migrations.ts`, `migrateEngagement(client)`, advisory-locked, recorded in `engagement_migrations`).
- [x] `visitor_hash` + `clientAddress` (last X-Forwarded-For) in `src/visitor.ts`.
- [x] Redis sliding-window limiter (atomic Lua, time from Redis `TIME`) + in-memory limiter (`src/rate-limit.ts`).
- [x] Service (`src/service.ts`): `toggleLike`, `likeState`, `createComment`, `editComment`, `deleteComment`, `listComments`, `updateAuthorSnapshot`, with `onCountChange(entityType, entityId, metric, delta, tx)` in the same transaction.
- [x] Handlers + router (`src/handlers.ts`): `createEngagementHandlers({service, salt, limiter, entities, resolveUser, canComment}).handle(request)`; routes `POST /likes/toggle`, `GET|POST /comments`, `PATCH|DELETE /comments/:id`.
- [x] `ENGAGEMENT_SALT` (+ `ENGAGEMENT_REDIS_URL`) documented in `.env.development.example`.
- [x] Tests: `test/visitor.test.ts`, `test/rate-limit.test.ts`, `test/engagement.integration.test.ts` (env-gated; skipped without the two URLs).

Lessons from building it (keep in mind):

- A first `toggleLike` (optimistic INSERT … ON CONFLICT, else DELETE, with retries) failed under 20 concurrent toggles by one user. It now takes `pg_advisory_xact_lock(hashtextextended(entity|actor))`, then DELETE-if-present else INSERT. Do not go back to a retry loop.
- Version: `@asafarim/engagement` is `0.1.0` (new). It is a brand-new package, so the 0.1.x → 0.2.0 rule starts applying from its next change.
- `pnpm platform:boundaries` needs every workspace package built (`pnpm install` for the whole repo); a filtered install fails it at `app-manifest#build`. Not caused by this package. Run a full `pnpm install` before Phase 3.
- Not done on purpose (record as hardening): the mutating handlers do not check `Origin`/CSRF; Auth.js session cookies are SameSite=Lax. Decide in Phase 3/4 whether the gateway or the handlers enforce it.
- `status` `hidden`/`deleted` exist in the schema but nothing sets them yet (moderation is later). A moderated parent hides its replies from the list but their visible rows still count in `comments_count`; define that before adding moderation.

### Phase 2 — client components (DONE; `packages/engagement/src/client`, export `./client`, `./styles.css`)

- [x] `<LikeButton />` (optimistic, rolled back on failure, explains a 429; guest's choice remembered in localStorage only as a hint), `<CommentSection />` (pinned first, 1-level replies, role badges, sign-in CTA for guests, "read only" note for a signed-in person without the permission, edit own, delete own / moderator with an inline confirmation, never `window.confirm`), `<EngagementBadge />` (plain markup, server-renderable).
- [x] `src/client/api.ts`: fetch client + pure list helpers (`insertComment`, `replaceComment`, `removeComment`), `compactCount`, `likedHint`.
- [x] New public route `GET /likes?entityType=&entityId=` (`likeState` for the person or guest) so the button can show "liked" on load.
- [x] New handler option `authorRole(user, entity)`: the badge cached with a comment can depend on the entity (Knowledge: "instructor" on your own course).
- [x] `styles.css` uses only `@asafarim/theme` tokens with fallbacks; every rule scoped to `.engagement-*`.
- [x] Tests: `test/client.test.tsx` (jsdom, fake fetch) + integration tests for `GET /likes` and `authorRole`. 70 tests green with real Postgres 16 + Redis 7.
- Version `0.1.0 → 0.2.0`. tsconfig gained `jsx: react-jsx` and the DOM lib.

### Phase 3 — integrate into `apps/knowledge` (DONE; knowledge `0.1.10 → 0.2.0`)

- [x] Migration 12 (`lib/migrations.ts`): `engagement_rollups` + `courses.likes_count/comments_count`. `lib/db.ts`
      `prepare()` runs `migrateEngagement` after Knowledge's own migrations (it opens its own transaction).
- [x] `lib/engagement-rollups.ts`: `applyCountChange`, `recountCourseEngagement` (called in `publishCourse`),
      `courseCounts`, `isEngageableLesson` (lesson of a published course with a public article), `lessonCourseOwner`.
- [x] `lib/engagement.ts` + `app/api/engagement/[...path]/route.ts`: handlers built once per process; entity `lesson`
      only; `canComment` = `gate("knowledge.comment.write")`; moderators = `knowledge.comment.moderate`; badge
      "instructor" for the course owner, "moderator" for a moderator; in-memory limiter 15/min (one instance, as search).
      Without `ENGAGEMENT_SALT` the route answers 503 and the pages render no like/comment UI.
- [x] Manifest: permissions `knowledge.comment.write` (author, editor, new role `knowledge.learner`) and
      `knowledge.comment.moderate` (editor); `publicPaths` `/api/engagement/**`; secret name `ENGAGEMENT_SALT`;
      `platform.app.json` recompiled (`pnpm platform manifest compile apps/knowledge/platform.app.ts`).
      **Deviation from the brief:** no gateway `routes` entry on `POST /api/engagement/comments`. The gateway answers a
      POST with an expired 60 s access token with 401 and no renewal (#363, see the studio note in the manifest), which
      would drop a comment. The app checks the permission on every request instead (as the studio actions do).
- [x] UI: lesson page — `LikeButton` ("Helpful") under the article, `CommentSection` at the bottom (guest gets the
      app's sign-in form); course page — `EngagementBadge` under the title; outline — a badge per module and lesson
      (hidden while zero). Styles: `@asafarim/engagement/styles.css` imported in `app/layout.tsx`.
- [x] `ENGAGEMENT_SALT`: dev — added to `.dev/app.env` by `scripts/dev/keys.mjs` (`appEnvAdditions`, so existing
      files gain it); e2e — `playwright.config.ts`; production — documented in `apps/knowledge/.env.production.example`.
      **Owner action:** add `ENGAGEMENT_SALT=<24 random bytes, base64url>` to `apps/knowledge/.env.production` and re-run
      `pnpm env:encrypt:production`; until then production shows no likes/comments (nothing breaks).
- [x] Tests: `test/engagement.integration.test.ts` (rollups, concurrency, republish recount, withdrawn course,
      handlers' entity check), `test/manifest.test.ts`, e2e guest like journey in `e2e/courses.spec.ts`.
- Grant `knowledge.learner` to readers (Admin console) for them to comment; anyone signed in without it sees
  "can read comments but not write them yet".

### After merge: Devin Review fixes on #397 (`0.2.0 → 0.3.0`)

- [x] `deleteComment` locks the parent's visible replies (`FOR UPDATE`) and counts only those, so a reply deleted at
      the same moment is not subtracted twice (regression test holds the reply's delete open in the hook).
- [x] `PATCH /comments/:id` checks `canComment` too: an author whose permission was revoked can't edit (may still delete).
- [x] Bodies are read as a stream and stopped past 16 KiB, with or without `Content-Length`.
- [x] `CommentSection` pages by what the server returned (`fetched`) and tracks comments posted locally separately, so
      "Show more" no longer skips an older comment after you post.
- [x] `styles.css`: `--accent-ink` / `--bad-ink` only on their solid fills; text on the page uses `--accent` / `--bad`
      / `--ink` (all pairs ≥ 5:1 in both themes).

### Phase 4 — hardening (DONE; engagement `0.3.0 → 0.4.0`, knowledge `0.2.0 → 0.3.0`)

- [x] `POST /api/engagement/likes/sync` + `service.syncGuestLikes(visitorHash, userId)`: a guest like becomes the
      person's; one they already had signed in is merged (guest row dropped, count −1). Same per-(entity, actor)
      advisory locks as `toggleLike`, taken in sorted order; at most `MAX_SYNC_LIKES` (500) per call. Client:
      `<GuestLikeSync userId>` (lesson page, signed in) posts once per person and browser, and only if localStorage
      remembers a like. Limitation: the visitor hash includes the address and User-Agent, so likes made on another
      network or browser can't be found.
- [x] `knowledge.comment.created.v1`: Knowledge migration 13 = the platform outbox (`OUTBOX_SQL`); schema
      `apps/knowledge/events/knowledge.comment.created.v1.json` (ids only, never the text or a name); published by the
      new `onCommentCreated(comment, tx)` service hook inside the comment's transaction (`lib/events.ts`); relay started
      in `instrumentation.ts` and woken after a 201; schemas uploaded for the Admin catalog (`lib/platform.ts`).
      Production: `ASAFARIM_NATS_URL: ${OS_NATS_URL:-}` added to os-knowledge (as Flow); the relay signs in with
      `ASAFARIM_REGISTRY_CREDENTIAL`, which Knowledge already has. No subscriber exists yet.
- [x] Nightly reconciliation: `lib/engagement-reconcile.ts` recounts lesson rows from `engagement_likes` / visible
      `engagement_comments`, then `recountCourseEngagement` for every published course, in one transaction under
      `pg_try_advisory_xact_lock`. Scheduled once a day from `instrumentation.ts` when `ENGAGEMENT_SALT` is set.
- [x] CSRF: handler option `siteOrigin(request)`; POST/PATCH/DELETE with a foreign `Origin` or
      `Sec-Fetch-Site: cross-site` get 403 before anything is read. Knowledge passes `visitorOrigin(headers)`.
- [x] CI already runs format, typecheck, lint, test, `platform sync --check`, manifest review and `env:check`.
- Not done (only if needed): a Redis limiter for Knowledge (one instance today); moderation statuses
  (`hidden`/`deleted` exist in the schema, nothing sets them) and pinning UI.

## Verify before continuing

```bash
cd asafarim-os && git checkout claude/serene-darwin-1d44kb && pnpm install --frozen-lockfile=false
pnpm --filter @asafarim/engagement typecheck && pnpm --filter @asafarim/engagement lint && pnpm --filter @asafarim/engagement test
pnpm --filter @asafarim/engagement build   # Knowledge imports dist/
pnpm --filter @asafarim/knowledge typecheck && pnpm --filter @asafarim/knowledge lint && pnpm --filter @asafarim/knowledge test
pnpm platform:sync:check && pnpm platform manifest review knowledge && pnpm env:check
```

Integration tests are skipped unless `ENGAGEMENT_TEST_DATABASE_URL` (and for the Redis limiter `ENGAGEMENT_TEST_REDIS_URL`) are set;
Knowledge's need `KNOWLEDGE_TEST_DATABASE_URL` (a server where they may create a throwaway database). E2E:
`KNOWLEDGE_E2E_ADMIN_URL=… pnpm --filter @asafarim/knowledge e2e` after `next build`. In the cloud sandbox turbo could
not spawn tasks ("Exec format error"); building the dependencies with `pnpm --filter "@asafarim/knowledge^..." -r run build`
works.

## Spec (condensed from the owner's brief)

- Tables: `engagement_likes(id, entity_type, entity_id, user_id?, visitor_hash?, created_at)` with the two partial UNIQUEs;
  `engagement_comments(id, entity_type, entity_id, user_id NOT NULL, author_snapshot jsonb {name, avatar_url, role}, parent_id?, body<=2000, is_pinned, status visible|hidden|deleted, created_at, updated_at)`.
- Routes: `POST /api/engagement/likes/toggle` (public; 15/min/IP; visitor hash; localStorage on the client),
  `GET /api/engagement/comments` (public), `POST …/comments` (`knowledge.comment.write`, gateway 401 for guests),
  `DELETE …/comments/:id` (author, or `knowledge.admin`/`core.admin`, enforced in app logic).
- Hook: lesson → module → course counter updates in the same transaction, for likes and comments.
- Client: `LikeButton`, `CommentSection` (pinned first, 1-level replies, instructor/admin badges, sign-in CTA), `EngagementBadge` (`♥ 124 • 💬 18`).
- Phase 4: guest→user like sync, event `…comment.created`, tests (anti-cheat duplicates, rollup math), CI checks.
