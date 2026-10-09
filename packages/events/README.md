# @asafarim/events

ASafariM OS events (P4.1, ADR 0001 §5). Apps integrate through **events**, not direct calls: an app publishes a fact (`notes.note.created.v1`), and an app that declared it subscribes. Neither knows the other.

This package is the publishing half: the envelope, payload validation, the transactional **outbox**, its **relay** to NATS JetStream, and the per-app **stream** bootstrap core-api runs at install. Subscribing (durable consumers, the inbox, dead letters) and bus-enforced permissions come in later slices. Apps use it through `@asafarim/app-sdk/events`, which re-exports it.

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

`startRelay({ appId, pool, servers })` (or `startAppRelay` in the SDK, which reads `ASAFARIM_NATS_URL`) runs in the app's process:

- publishes pending rows **oldest first** to the subject = the event type, with **`Nats-Msg-Id` = the event id**, so JetStream drops a re-send inside its duplicate window (10 minutes);
- marks a row sent only after the PubAck (a duplicate ack counts), keeps `attempts` and `last_error`, and **never deletes an unsent row**;
- on a failure stops the batch (order is kept) and backs off, 250 ms doubling up to 10 s; with the bus down, the app keeps working and its events wait;
- holds each batch with `FOR UPDATE SKIP LOCKED`, so several app processes don't send the same row at once;
- **never creates a stream**. `stop()` waits for the current batch and closes its connection.

## Streams

One per publishing app: `APP_<ID>` on subjects `<id>.>`, file storage. **core-api creates it at install** (`createStreamAdmin({ servers }).ensureAppStream(appId)`, idempotent), never the app.

## Test

```bash
pnpm --filter @asafarim/events test
```

The integration suite (`test/relay.integration.test.ts`) needs a dev Postgres and the dev NATS: `EVENTS_TEST_ADMIN_URL=postgres://postgres:postgres-dev-only@127.0.0.1:55440/postgres` and `EVENTS_TEST_NATS_URL=nats://127.0.0.1:54222` (both from `pnpm dev`). It uses a throwaway database and stream and removes them. CI's `dev-env` job runs it with `EVENTS_TEST_REQUIRED=1`, so it fails rather than skips.
