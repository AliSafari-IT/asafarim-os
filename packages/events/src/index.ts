/**
 * @asafarim/events (P4.1, ADR 0001 §5): apps integrate through events, not direct calls.
 *
 *   const publisher = createPublisher({ manifest, schemas });          // validates against the manifest's schemas
 *   await publisher.publish(tx, "notes.note.created.v1", data, { subject }); // one outbox row, in YOUR transaction
 *   const relay = startRelay({ appId, pool, servers });                // outbox → JetStream (Nats-Msg-Id = event id)
 *   await createStreamAdmin({ servers }).ensureAppStream(appId);       // core-api, at install: APP_<ID> on <id>.>
 *   await createStreamAdmin({ servers }).ensureConsumer(appId, type);  // core-api: durable <app>.<type> on the publisher's stream
 *   const sub = subscribe(type, async (event, tx) => {…}, { appId, pool, servers }); // inbox + handler in one tx, ack after commit
 */
export * from "./envelope.ts";
export * from "./inbox-sql.ts";
export * from "./outbox-sql.ts";
export * from "./publisher.ts";
export * from "./relay.ts";
export * from "./streams.ts";
export * from "./subscriber.ts";
export * from "./ulid.ts";
