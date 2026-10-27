# apps/flow

**Flow**, ASafariM Flow (ADR 0001): workflows across the OS apps, **through events only**. It subscribes to an app's fact events (triggers), publishes request events under its own `flow.*` namespace, and waits for the acting app's outcome events. It never calls another app's HTTP API or reads its database.

Its first workflow (slice 1): the owner writes `#issue` in a Docs study note → Flow starts a run → Docs drafts a GitHub issue → the owner approves in Flow → Docs creates the issue. This app is the skeleton and the engine (Flow PR 3); the approval step (PR 4) and Docs's handlers (PRs 4 and 5) come next, so a run stops at the approval for now.

It follows the same steps as [`apps/notes`](../notes/README.md): install → register → sign in → an admin grants a role.

| Permission              | What                                         | Roles that carry it                          |
| ----------------------- | -------------------------------------------- | -------------------------------------------- |
| `flow.read`             | see workflows and runs                       | `flow.viewer`, `flow.approver`, `flow.owner` |
| `flow.workflows.write`  | pause and resume a workflow                  | `flow.owner`                                 |
| `flow.runs.start`       | retry or cancel a run                        | `flow.owner`                                 |
| `flow.approvals.decide` | approve or reject a step (used from PR 4 on) | `flow.approver`, `flow.owner`                |

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

Both schemas have `additionalProperties: false`, and ids are strings. Docs doesn't publish the four outcomes yet, so core-api reports them as `waiting_for_publisher` and `pnpm platform manifest review` lists them (`subscription-not-published`): expected until PRs 4 and 5. An outcome must carry the `runId` and `stepId` of the request; it may also carry `requestId` (the request's event id), and then an answer to an earlier attempt of a retried step is ignored.

## Workflows

A workflow definition (`lib/workflow/definition.ts`) is typed and checked with Zod before it is stored. A **version is immutable** (a trigger in the database refuses an `UPDATE`), and a run is **pinned to the version** it started on. On first start Flow seeds version 1 of `docs-note-to-issue` (`lib/workflow/seed.ts`), idempotently.

| Step        | Fields                                     | What it does                                                                                                |
| ----------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `condition` | `all: [{ field, op, value }]`              | every clause holds → the next step; otherwise the run ends `skipped`                                        |
| `action`    | `request`, `done`, `failed`, `timeout`     | publishes `request`, waits for `done` (output = its payload) or `failed` (the run fails), `timeout` at most |
| `approval`  | `role`, `deadline`, `onExpire`, `editable` | for now: the step and the run wait with `approval_not_implemented` (PR 4 replaces it)                       |
| `end`       |                                            | the run succeeds                                                                                            |

- **Conditions** are deliberately small: `equals`, `notEquals`, `contains` (an array item or a substring). Fields are paths into `trigger.*` and `steps.<key>.output.*` of an earlier step; nothing else, and no expression language.
- **Requests** are built by one typed function per request type (`lib/workflow/requests.ts`), not a template language. A definition may only name a request type listed there, and every payload is checked against its JSON Schema when it is published. A run that lacks what a request needs fails that step with `request_mapping_failed` and publishes nothing.
- **Durations** are ISO 8601 in days, hours, minutes and seconds (`PT5M`, `P7D`).

## The engine

`lib/engine/engine.ts` makes every transition in **one database transaction together with the outbox row it publishes**, so a step never waits without its request and no request goes out for a step that isn't waiting. Every change to a run holds its row lock (`FOR UPDATE`), so an outcome, the sweeper, a retry and a cancel never interleave on one run.

- **Trigger:** each of the app's subscriptions runs the SDK's `subscribe` (the inbox row and the transition in one transaction, ack after commit). An active workflow whose current version is triggered by the event gets a run; `trigger_event_id` is unique, a second guard after the inbox. A paused workflow starts nothing; runs already going carry on.
- **Outcome:** matched by `runId` + `stepId`, and only while the step and the run are waiting. A late or duplicate outcome (or one of the wrong type, for an unknown run or step) is ignored and logged (`flow.outcome.ignored`).
- **Timeouts:** a sweeper in the app process, every 15 s, takes one overdue run at a time (`FOR UPDATE SKIP LOCKED`, so several instances share the work): the step `timed_out`, the run `failed` with `action_timeout`.
- **Retry** (`flow.runs.start`) of a failed or timed-out run re-executes its failed step with a **new** request event id (`attempts` + 1). **Cancel** sets the run `cancelled` and a waiting step `skipped`.

Run statuses: `running`, `waiting`, `succeeded`, `failed`, `skipped`, `rejected`, `cancelled`. Step statuses: `pending`, `running`, `waiting`, `succeeded`, `failed`, `timed_out`, `skipped`.

**Audit:** `flow.run.started`, `flow.run.finished`, `flow.run.retried`, `flow.run.cancelled`, `flow.workflow.paused`, `flow.workflow.resumed`, one JSON log line each (`audit: true`, `lib/audit.ts`), written once the transaction committed. Ids only (run, step, workflow key, the acting subject), never a payload.

**Retention:** a daily job (and once a minute after boot) clears `input` and `output` of steps whose run ended more than 30 days ago. Statuses, timing, ids and error codes stay.

## Database

Flow's own Postgres (`DATABASE_URL`, created by `platform app install`), migrated by `lib/migrations.ts` (numbered, recorded in `flow_migrations`, under an advisory lock): `workflows`, `workflow_versions`, `workflow_runs`, `workflow_run_steps`, `approvals` (the table only, used from PR 4), and the SDK's `asafarim_outbox` and `asafarim_inbox`.

## Pages

Server-rendered, every one gated by `lib/page.ts` (not signed in → 401, without `flow.read` → 403):

- **Overview** (`/`): runs waiting, failures in the last 7 days, the last 10 runs.
- **Runs** (`/runs`): newest first; skipped runs are hidden unless **Show skipped runs** is ticked.
- **Run** (`/runs/<id>`): each step with its status, timing, attempts, input, output, error code and message; **Retry** and **Cancel run** for `flow.runs.start`.
- **Workflows** (`/workflows`): the current definition, read-only; **Pause** and **Resume** for `flow.workflows.write`.

## Try it

```bash
pnpm dev                                          # installs and activates flow: http://flow.localhost:8080 (or localhost:4130)
pnpm platform role grant flow.owner dev-admin     # nobody holds a flow role by default
pnpm platform role grant docs.owner dev-admin     # to write the note in Docs
```

Write a study note with `#issue` in Docs: a run appears on Flow's Overview, waiting on its draft step. Docs doesn't answer `flow.issue-draft.requested.v1` yet, so after 5 minutes the sweeper times it out; **Retry** sends a new request.

## Test

```bash
pnpm --filter @asafarim/flow test   # unit tests; with FLOW_TEST_ADMIN_URL (a dev Postgres superuser URL) also the integration test
pnpm e2e                            # flow.spec.ts last: a #issue note in Docs → a waiting run in Flow, through the bus
```

- `test/definition.test.ts`, `test/conditions.test.ts` and `test/requests.test.ts`: the format, the operators and the request mappings against their schemas.
- `test/engine.test.ts`: every transition, the sweeper, retry and cancel, over an in-memory store (`test/memory-store.ts`) with the real publisher.
- `test/flow.integration.test.ts` (real Postgres, `FLOW_TEST_ADMIN_URL` or `EVENTS_TEST_ADMIN_URL`; skipped without): a `#issue` note waits on the draft step with its request in the outbox, one without the tag is skipped, a duplicate creates nothing; the sweeper with `SKIP LOCKED`, retry, retention, and immutable versions.
- `test/routes.test.ts`: every page and server action found on disk is gated.

## Layout

| Path                         | What                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `platform.app.ts` / `.json`  | the manifest (and its compiled form, which `platform sync` reads)                      |
| `events/*.json`              | the JSON Schemas of the two requests Flow publishes                                    |
| `instrumentation.ts`         | on boot: registration, migrations and seed, the relay, subscribers, sweeper, retention |
| `lib/workflow/`              | the definition format, conditions, request mappings, the seeded workflow               |
| `lib/engine/`                | the engine, its store (Postgres), the workers (subscribers, sweeper), retention        |
| `lib/db.ts`                  | the app's own database, its transaction helper, the engine instance and the relay      |
| `lib/migrations.ts`          | the numbered migrations                                                                |
| `lib/queries.ts`             | what the pages read                                                                    |
| `lib/gate.ts`, `lib/page.ts` | signed in? app active? has the permission? for actions and pages                       |
| `app/`                       | the pages, the server actions, health and the sign-in routes                           |

The core never imports this app: `pnpm platform:boundaries` proves it.
