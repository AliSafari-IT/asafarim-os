/**
 * `@asafarim/app-sdk/events` (P4.1): publishing events from an app. A separate entry point so the
 * main SDK (also imported by pages) never pulls in the NATS client.
 *
 *   const publisher = createPublisher({ manifest, schemas });          // checks every declared schema
 *   await publisher.publish(tx, "notes.note.created.v1", data, { subject: id }); // inside YOUR transaction
 *   startAppRelay({ appId, pool });                                    // on boot: outbox → JetStream
 */
import { startRelay, type Relay, type RelayOptions } from "@asafarim/events";
import { consoleLogger } from "./register.ts";

export * from "@asafarim/events";

export interface StartAppRelayOptions extends Omit<RelayOptions, "servers" | "jetstream"> {
  /** Defaults to process.env: ASAFARIM_NATS_URL (comma-separated servers). */
  env?: Record<string, string | undefined>;
}

/**
 * Start the outbox relay when the platform gave the app a bus (ASAFARIM_NATS_URL). Without one it
 * logs once and returns undefined: events wait in the outbox, nothing is lost, and they go out
 * when the app runs with a bus.
 */
export function startAppRelay(opts: StartAppRelayOptions): Relay | undefined {
  const env = opts.env ?? process.env;
  const log = opts.log ?? consoleLogger;
  const servers = env.ASAFARIM_NATS_URL?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!servers?.length) {
    log.warn("events.relay.no_bus", {
      appId: opts.appId,
      hint: "ASAFARIM_NATS_URL is not set: events stay in the outbox until the app runs with a bus",
    });
    return undefined;
  }
  return startRelay({ ...opts, servers, log });
}
