# apps/flow

**Flow**, ASafariM Flow (ADR 0001): workflows across the OS apps, **through events only**. It subscribes to an app's fact events (triggers), publishes request events under its own `flow.*` namespace, and waits for the acting app's outcome events. It never calls another app's HTTP API or reads its database.

Its first workflow (slice 1): the owner writes `#issue` in a Docs study note → Flow starts a run → Docs drafts a GitHub issue → the owner approves in Flow → Docs creates the issue. Flow has the engine (Flow PR 3) and the approval step with its Approvals page (PR 4b); Docs answers the draft request (PR 4a, [#254](https://github.com/AliSafari-IT/asafarim-os/pull/254)); creating the issue comes in PR 5.

It follows the same steps as [`apps/notes`](../notes/README.md): install → register → sign in → an admin grants a role.

| Permission              | What                                   | Roles that carry it                          |
| ----------------------- | -------------------------------------- | -------------------------------------------- |
| `flow.read`             | see workflows and runs                 | `flow.viewer`, `flow.approver`, `flow.owner` |
| `flow.workflows.write`  | pause and resume a workflow            | `flow.owner`                                 |
| `flow.runs.start`       | retry or cancel a run                  | `flow.owner`                                 |
| `flow.approvals.decide` | the Approvals pages: approve or reject | `flow.approver`, `flow.owner`                |

## Events

| Direction  | Type                            | What                                                                                                                                                                                    |
| ---------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| subscribes | `docs.note.created.v1`          | the trigger (Docs, [#250](https://github.com/AliSafari-IT/asafarim-os/pull/250))                                                                                                        |
| publishes  | `flow.issue-draft.requested.v1` | `{ runId, stepId, noteId, onBehalfOf }` ([schema](events/flow.issue-draft.requested.v1.json))                                                                                           |
| subscribes | `docs.issue-draft.ready.v1`     | the draft (its payload is the step's output)                                                                                                                                            |
| subscribes | `docs.issue-draft.failed.v1`    | `{ runId, stepId, code, message }`                                                                                                                                                      |
| publishes  | `flow.issue.approved.v1`        | the approved draft: `runId, stepId, approvalId, noteId, onBehalfOf, decidedBy, decidedAt, repo, title, body, labels, acknowledgedPublic` ([schema](events/flow.issue.approved.v1.json)) |
| subscribes | `docs.issue.created.v1`         | the issue                                                                                                                                                                               |
| subscribes | `docs.issue.failed.v1`          | `{ runId, stepId, code, message }`                                                                                                                                                      |

Both schemas have `additionalProperties: false`, and ids are strings. Docs publishes the two draft outcomes (#254) but not yet `docs.issue.created.v1` and `docs.issue.failed.v1`, so core-api reports those as `waiting_for_publisher` and `pnpm platform manifest review` lists them (`subscription-not-published`): expected until PR 5. An outcome must carry the `runId` and `stepId` of the request; it may also carry `requestId` (the request's event id), and then an answer to an earlier attempt of a retried step is ignored.

## Workflows

A workflow definition (`lib/workflow/definition.ts`) is typed and checked with Zod before it is stored. A **version is immutable** (a trigger in the database refuses an `UPDATE`), and a run is **pinned to the version** it started on. On first start Flow seeds version 1 of `docs-note-to-issue` (`lib/workflow/seed.ts`), idempotently.

| Step        | Fields                                     | What it does                                                                                                        |
| ----------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `condition` | `all: [{ field, op, value }]`              | every clause holds → the next step; otherwise the run ends `skipped`                                                |
| `action`    | `request`, `done`, `failed`, `timeout`     | publishes `request`, waits for `done` (output = its payload) or `failed` (the run fails), `timeout` at most         |
| `approval`  | `role`, `deadline`, `onExpire`, `editable` | a pending approval for a person; approved → the next step, rejected → the run ends `rejected` ([below](#approvals)) |
| `end`       |                                            | the run succeeds                                                                                                    |

- **Conditions** are deliberately small: `equals`, `notEquals`, `contains` (an array item or a substring). Fields are paths into `trigger.*` and `steps.<key>.output.*` of an earlier step; nothing else, and no expression language.
- **Requests** are built by one typed function per request type (`lib/workflow/requests.ts`), not a template language. A definition may only name a request type listed there, and every payload is checked against its JSON Schema when it is published. A run that lacks what a request needs fails that step with `request_mapping_failed` and publishes nothing.
- **Durations** are ISO 8601 in days, hours, minutes and seconds (`PT5M`, `P7D`).

## The engine

`lib/engine/engine.ts` makes every transition in **one database transaction together with the outbox row it publishes**, so a step never waits without its request and no request goes out for a step that isn't waiting. Every change to a run holds its row lock (`FOR UPDATE`), so an outcome, the sweeper, a retry and a cancel never interleave on one run.

- **Trigger:** each of the app's subscriptions runs the SDK's `subscribe` (the inbox row and the transition in one transaction, ack after commit). An active workflow whose current version is triggered by the event gets a run; `trigger_event_id` is unique, a second guard after the inbox. A paused workflow starts nothing; runs already going carry on.
- **Outcome:** matched by `runId` + `stepId`, and only while the step and the run are waiting. A late or duplicate outcome (or one of the wrong type, for an unknown run or step) is ignored and logged (`flow.outcome.ignored`).
- **Timeouts:** a sweeper in the app process, every 15 s, takes one overdue run at a time (`FOR UPDATE SKIP LOCKED`, so several instances share the work): the step `timed_out`, the run `failed` with `action_timeout`.
- **Timeouts and deadlines:** the same sweeper also expires a pending approval past its deadline: the approval `expired`, its step `timed_out`, the run `failed` with `approval_expired` (`onExpire: stop`).
- **Retry** (`flow.runs.start`) of a failed or timed-out run re-executes its failed step with a **new** request event id (`attempts` + 1). After an approval, that is the failed `create` step: the approval stays decided and the request carries the same decision. After an expiry, it is the review step: a **new** approval (the expired one stays expired). **Cancel** sets the run `cancelled`, a waiting step `skipped` and a pending approval `cancelled`.

## Approvals

Reaching an approval step, the engine (in the same transaction) checks the **draft**, the output of the action just before it (`docs.issue-draft.ready.v1` minus `runId`, `stepId`, `requestId`: `{ noteId, docPath, repo, public, title, body, labels }`, untrusted, `lib/workflow/approval.ts`). A draft that doesn't fit fails the step with `invalid_draft` and nobody is asked. Otherwise: an `approvals` row `pending` (`assignee_role` from the step, `deadline` = now + the step's deadline), the step `waiting` with the draft as its input, the run `waiting`.

Deciding takes `flow.approvals.decide` (the role in `assignee_role` is informational; `flow.owner` decides too). Each decision is one transaction that locks the run, with the outbox row when the next step publishes:

- **Approve** (`engine.approve`): edits may only change the step's `editable` fields (title 1..256, body 1..60 000, labels at most 20, distinct, each 1..50), otherwise `edit_not_allowed` or `invalid_edits`. A draft for a **public** repository needs `acknowledgedPublic`, otherwise `public_not_acknowledged`. The approval `approved` (`decided_by`, `decided_at`, `edited`: only the fields that changed, with their new values), the step `succeeded` with the decision as its output (`{ noteId, repo, title, body, labels, acknowledgedPublic, approvalId, decidedBy, decidedAt }`), and the `create` step publishes `flow.issue.approved.v1` (`onBehalfOf` is the note's author, `trigger.author`).
- **Reject** (`engine.reject`), with an optional comment (at most 1000): the approval `rejected`, the step `failed` (`rejected`), the run `rejected`. A rejected run isn't retried.
- Deciding twice, past the deadline, or on a run that doesn't wait on that approval: `not_pending` (the page shows **409 Conflict**). A database index keeps one pending approval per step.

**Audit:** `flow.approval.decided` (`approvalId`, `runId`, `stepId`, `decision`, the decider): ids only, never the draft or the comment.

Run statuses: `running`, `waiting`, `succeeded`, `failed`, `skipped`, `rejected`, `cancelled`. Step statuses: `pending`, `running`, `waiting`, `succeeded`, `failed`, `timed_out`, `skipped`.

**Audit:** `flow.run.started`, `flow.run.finished`, `flow.run.retried`, `flow.run.cancelled`, `flow.approval.decided`, `flow.workflow.paused`, `flow.workflow.resumed`, one JSON log line each (`audit: true`, `lib/audit.ts`), written once the transaction committed. Ids only (run, step, workflow key, the acting subject), never a payload.

**Retention:** a daily job (and once a minute after boot) clears `input` and `output` of steps, and `edited` and `comment` of approvals, whose run ended more than 30 days ago. Statuses, timing, ids, who decided and error codes stay.

## Database

Flow's own Postgres (`DATABASE_URL`, created by `platform app install`), migrated by `lib/migrations.ts` (numbered, recorded in `flow_migrations`, under an advisory lock): `workflows`, `workflow_versions`, `workflow_runs`, `workflow_run_steps`, `approvals` (migration 2 adds an index by run and one pending approval per step), and the SDK's `asafarim_outbox` and `asafarim_inbox`.

## Pages

Server-rendered, every one gated by `lib/page.ts` (not signed in → 401, without `flow.read` → 403; the Approvals pages without `flow.approvals.decide` → 403):

- **Overview** (`/`): **Waiting for your approval** (the count, for `flow.approvals.decide`), runs waiting, failures in the last 7 days, the last 10 runs.
- **Runs** (`/runs`): newest first; skipped runs are hidden unless **Show skipped runs** is ticked.
- **Run** (`/runs/<id>`): each step with its status, timing, attempts, input, output, error code and message; an approval step with its approval's state and decision; **Retry** and **Cancel run** for `flow.runs.start`.
- **Approvals** (`/approvals`): pending approvals, oldest first: the run, the document, the repository, how long until the deadline.
- **Approval** (`/approvals/<id>`): the repository (a **This repository is public** banner when it is), the editable title, body and labels, a preview of the body, a link **Open the document in Docs** (`<docs.url>/<docPath>`), **Approve** (with the edits; the public checkbox when public) and **Reject** (an optional comment). Server actions, so Next.js checks the request's origin; the preview is the body's Markdown through `rehype-sanitize`'s default schema (no raw HTML), external links `rel="noopener noreferrer"`, relative links and images shown as text (`components/Preview.tsx`, `lib/rehype.ts`).

**Config:** `docs.url` (`APP_CONFIG_DOCS_URL`), where Docs is served; default `https://docs.asafarim.site`, and `http://docs.localhost:8080` in local dev (`next.config.ts`, when `.dev/` exists).

- **Workflows** (`/workflows`): the current definition, read-only; **Pause** and **Resume** for `flow.workflows.write`.

## In production

<https://flow.asafarim.site>, the `os-flow` service of [`deploy/compose.prod.yml`](../../deploy/compose.prod.yml) (image from `Dockerfile`, published by the "Flow image" workflow after a smoke test). It is **off until `apps/flow/.env.production.age` is committed**; then the full deploy starts it next to core-api and publishes its site. The owner's steps (env, identity client, install, activate, grant) are in [`deploy/README.md`](../../deploy/README.md#flowasafarimsite).

In production `ASAFARIM_NATS_URL` is set by the deploy only when it runs the event bus (`os-nats`, `deploy/README.md`) and is **empty** otherwise. Without a bus Flow starts, serves its pages and is healthy, and logs once that its subscribers (`flow.subscribers.no_bus`) and its relay (`events.relay.no_bus`) are off, so it runs no workflow from Docs events. Before `admin.sh install flow` gives it a database it logs `flow.workers.no_database` and serves pages and health only. `test/workers.test.ts` and the image's smoke test check this.

## Try it

```bash
pnpm dev                                          # installs and activates flow: http://flow.localhost:8080 (or localhost:4130)
pnpm platform role grant flow.owner dev-admin     # nobody holds a flow role by default
pnpm platform role grant docs.owner dev-admin     # to write the note in Docs
```

Write a study note with `#issue` in Docs: a run appears on Flow's Overview, waiting on its draft step. Once Docs answers with the draft, it waits on **Approvals**; approve it and `flow.issue.approved.v1` goes to Docs. Without an answer, the sweeper times the draft out after 5 minutes; **Retry** sends a new request.

## Test

```bash
pnpm --filter @asafarim/flow test   # unit tests; with FLOW_TEST_ADMIN_URL (a dev Postgres superuser URL) also the integration test
pnpm e2e                            # flow.spec.ts last: slice 1 end to end through the bus, GitHub and Claude mocked
```

- `e2e/flow.spec.ts` (`pnpm e2e`): a `#issue` note in Docs → Docs' draft under Approvals (repository, public banner, title, body, labels) → Approve creates exactly one issue and the note links it "via Flow", the run `succeeded` with every step timed; Reject ends it `rejected`; a note that got an issue meanwhile fails with `issue_exists`; without `flow.approvals.decide` the pages and the action are 403; without Docs' permission the create step fails with `forbidden`. Each failure's code and message is checked on the Run page. GitHub and Claude are local mocks (`e2e/mocks.mjs`, its own process); `scripts/dev/e2e.mjs` restarts Docs against them (`DOCS_E2E_GITHUB_API_URL`, `DOCS_E2E_AI_API_URL`, loopback only) before this suite, and the spec counts the issues the GitHub mock holds (`E2E_GITHUB_MOCK_URL`).

- `test/definition.test.ts`, `test/conditions.test.ts` and `test/requests.test.ts`: the format, the operators and the request mappings against their schemas.
- `test/engine.test.ts`: every transition, the sweeper, retry and cancel, and the approval (reached, approved with and without edits, edits outside `editable`, public without acknowledgement, rejected, decided twice, expired, cancelled, retried after it), over an in-memory store (`test/memory-store.ts`) with the real publisher, so `flow.issue.approved.v1` is checked against its schema. The draft is fed to the engine as a `docs.issue-draft.ready.v1` outcome.
- `test/approval-page.test.ts`: the link to Docs (encoded, never outside Docs' root) and the sanitized preview.
- `test/flow.integration.test.ts` (real Postgres, `FLOW_TEST_ADMIN_URL` or `EVENTS_TEST_ADMIN_URL`; skipped without): a `#issue` note waits on the draft step with its request in the outbox, one without the tag is skipped, a duplicate creates nothing; the sweeper with `SKIP LOCKED`, retry, retention, and immutable versions; approve (its request in the outbox), reject, expiry and cancel on the Postgres store.
- `test/routes.test.ts`: every page and server action found on disk is gated (the Approvals pages and decisions by `flow.approvals.decide`).

## Layout

| Path                         | What                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `platform.app.ts` / `.json`  | the manifest (and its compiled form, which `platform sync` reads)                      |
| `events/*.json`              | the JSON Schemas of the two requests Flow publishes                                    |
| `instrumentation.ts`         | on boot: registration, migrations and seed, the relay, subscribers, sweeper, retention |
| `lib/workflow/`              | the definition format, conditions, request mappings, the approval, the seed            |
| `lib/engine/`                | the engine, its store (Postgres), the workers (subscribers, sweeper), retention        |
| `lib/db.ts`                  | the app's own database, its transaction helper, the engine instance and the relay      |
| `lib/migrations.ts`          | the numbered migrations                                                                |
| `lib/queries.ts`             | what the pages read                                                                    |
| `lib/gate.ts`, `lib/page.ts` | signed in? app active? has the permission? for actions and pages                       |
| `app/`                       | the pages, the server actions, health and the sign-in routes                           |

The core never imports this app: `pnpm platform:boundaries` proves it.
