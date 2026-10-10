# @asafarim/events

ASafariM OS events (P4.1, ADR 0001 §5). Apps integrate through **events**, not direct calls: an app publishes a fact (`notes.note.created.v1`), and an app that declared it subscribes. Neither knows the other.

This package has both halves. Publishing: the envelope, payload validation, the transactional **outbox**, its **relay** to NATS JetStream, and the per-app **stream** bootstrap core-api runs at install. Subscribing: **durable consumers** (created by core-api), the **inbox** that makes a handler run once per event, and **dead letters**. Bus-enforced permissions: every client signs in to the bus with an `auth` option (`{ user, pass: () => string }`, a fresh password per connect); core-api checks it and grants only what the app's manifest declares (see core-api's README). Apps use it through `@asafarim/app-sdk/events`, which re-exports it.

## Publish

```ts
const publisher = createPublisher({ manifest, schemas: { "./events/notes.note.created.v1.json": schema } });

await client.query("BEGIN");
const note = (await client.query("INSERT INTO notes … RETURNING *", […])).rows[0];
await publisher.publish(client, "notes.note.created.v1", { id: note.id, … }, { subject: note.id, traceparent });
await client.query("COMMIT");
```

- `schemas` is keyed by the path the manifest's `events.publishes[].schema` names. `loadSchemas(manifest, appDir)` reads them from disk. A declared type without a schema, or a schema that doesn't compile (JSON Schema 2020-12, with formats), throws at `createPublisher`.
- `publish` throws **before any write** for a type the manifest doesn't publish (`UndeclaredEventError`) or a payload its schema refuses (`EventValidationError`). Both are programming errors.
- It writes **one outbox row through your client**, inside your transaction. Nothing is sent until the transaction commits and the relay picks the row up, so there are no dual writes.

## The envelope

CloudEvents 1.0, structured JSON mode: `specversion`, `id` (a ULID), `source` (`asafarim://<app-id>`), `type`, `subject`, `time`, `datacontenttype` (`application/json`), `data`, and the W3C `traceparent` as an extension attribute when given. `createEvent` builds one and refuses a type outside the app's namespace or a malformed traceparent.

## The outbox

`asafarim_outbox` (prefixed so it can't collide with an app's tables). The same DDL ships three ways, and a test keeps them equal:

| Where                                                    | For                                    |
| -------------------------------------------------------- | -------------------------------------- |
| `OUTBOX_SQL`                                             | running it from code (what notes does) |
| `@asafarim/events/sql/outbox.sql` (`sql/001_outbox.sql`) | a plain-SQL migrations folder          |
| `@asafarim/events/drizzle/outbox.sql`                    | a Drizzle migrations folder            |

## The relay

`startRelay({ appId, pool, servers, auth })` (`auth`: how it signs in to a bus that checks identities; or `startAppRelay` in the SDK, which reads `ASAFARIM_NATS_URL`) runs in the app's process:

- publishes pending rows **oldest first** to the subject = the event type, with **`Nats-Msg-Id` = the event id**, so JetStream drops a re-send inside its duplicate window (10 minutes);
- marks a row sent only after the PubAck (a duplicate ack counts), keeps `attempts` and `last_error`, and **never deletes an unsent row**;
- on a failure stops the batch (order is kept) and backs off, 250 ms doubling up to 10 s; with the bus down, the app keeps working and its events wait;
- holds each batch with `FOR UPDATE SKIP LOCKED`, so several app processes don't send the same row at once;
- **never creates a stream**. `stop()` waits for the current batch and closes its connection.

## Streams

One per publishing app: `APP_<ID>` on subjects `<id>.>`, file storage. **core-api creates it at install** (`createStreamAdmin({ servers }).ensureAppStream(appId)`, idempotent), never the app.

## Subscribe

```ts
const sub = subscribe<NoteCreatedV1>(
  "notes.note.created.v1",
  async (event, tx) => {
    await tx.query("INSERT INTO mentions (note_id) VALUES ($1)", [event.data.id]); // YOUR transaction
  },
  { appId: "tasks", pool, servers },
);
// …
await sub.stop();
```

- It consumes the durable consumer **`<consumer-app>.<type>`** (every `.` turned into `_` for NATS, e.g. `tasks_notes_note_created_v1`) on the publisher's stream, filter subject = the type, explicit ack. **core-api creates it** (below); `subscribe` never creates streams or consumers, and retries with a backoff while the consumer or the bus isn't there.
- Each delivery runs `BEGIN → INSERT INTO asafarim_inbox (event_id …) ON CONFLICT DO NOTHING → handler(event, tx) → COMMIT → ack`. An event id already in the inbox is **acked without calling the handler** (a redelivery, or a re-publish with a new `Nats-Msg-Id`). The ack comes **only after the commit**; a crash between the two is a redelivery the inbox absorbs.
- A handler error **rolls back** (no inbox row, none of the handler's writes) and **naks with a delay** (500 ms doubling up to 30 s, `backoff`).
- The **`maxDeliver`-th handler failure** (default 5) publishes a dead letter to **`deadletter.<consumer-app>.<type>`** and terminates the message, so it is never redelivered. The dead letter is `{ envelope, failure: { consumer, type, reason, attempts, deliveries, error, stream, streamSeq, deadLetteredAt } }`: the original envelope, the handler failures counted (`attempts`), the bus's delivery count (`deliveries`), and the last error's message, never a stack trace. If the dead letter can't be stored, the message is nak'ed and dead-lettered on the next delivery (without running the handler again). An envelope that isn't valid JSON, or not the subscribed type from its publisher, is dead-lettered at once (`reason: "invalid_envelope"`).
- **Only the handler's failures count.** A database failure that isn't the handler's (`pool.connect()`, `BEGIN`, the inbox `INSERT`, a `COMMIT` that isn't a constraint violation) naks with the same backoff and counts nothing, so an outage of any length never dead-letters an event; the handler runs once the database is back. A `COMMIT` that fails on a deferred constraint (SQLSTATE class 23) is the handler's writes' fault and counts.
- The counts live **in the subscriber process's memory**, per stream message (the bus's own delivery count also counts outage redeliveries, so it isn't used). After a restart they start again from zero: an event that keeps failing gets up to `maxDeliver` more handler attempts, and a dead letter whose publish failed just before the restart is retried by running the handler again. With several replicas on one consumer, each counts its own attempts.
- The handler budget is the consumer's `ack_wait` (30 s): a delivery still running after that is redelivered while it runs. The inbox makes that safe (the second insert waits on the row lock, then is a duplicate), but keep handlers well under 30 s.
- Deliveries run one at a time, in stream order. The handler gets the event and the transaction (`tx`): write through it.

The inbox ships like the outbox, three ways, and a test keeps them equal:

| Where                                                  | For                           |
| ------------------------------------------------------ | ----------------------------- |
| `INBOX_SQL`                                            | running it from code          |
| `@asafarim/events/sql/inbox.sql` (`sql/002_inbox.sql`) | a plain-SQL migrations folder |
| `@asafarim/events/drizzle/inbox.sql`                   | a Drizzle migrations folder   |

### Consumers and dead letters (core-api)

`createStreamAdmin({ servers }).ensureConsumer(consumerApp, type)` creates or updates the durable consumer (idempotent), new messages only (from its creation on), `ack_wait` 30 s, no delivery cap on the bus side (the subscriber counts attempts and dead-letters, so a dead letter that couldn't be stored isn't silently dropped). It returns `no_stream`, and creates nothing, when the publisher's stream doesn't exist yet (core-api reports that as `waiting_for_publisher` and creates the consumer when the publisher is installed). It first ensures the shared **`DEADLETTER`** stream on `deadletter.>` (file storage, kept 30 days), which core-api also ensures at boot; apps never create it. `deleteConsumer(consumerApp, type)` removes the durable consumer when an upgrade drops the subscription: `deleted`, or `absent` when it (or the stream) is already gone.

## Test

```bash
pnpm --filter @asafarim/events test
```

The integration suites (`test/relay.integration.test.ts`, `test/consumer.integration.test.ts`) needs a dev Postgres and the dev NATS: `EVENTS_TEST_ADMIN_URL=postgres://postgres:postgres-dev-only@127.0.0.1:55440/postgres` and `EVENTS_TEST_NATS_URL=nats://127.0.0.1:54222` (both from `pnpm dev`), plus `NATS_CORE_PASSWORD` from `.dev/nats.env` (the dev bus refuses anonymous clients; the tests sign in as `core`). It uses a throwaway database and stream and removes them. CI's `dev-env` job runs it with `EVENTS_TEST_REQUIRED=1`, so it fails rather than skips.
