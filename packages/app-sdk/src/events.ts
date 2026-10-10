/**
 * `@asafarim/app-sdk/events` (P4.1): publishing events from an app. A separate entry point so the
 * main SDK (also imported by pages) never pulls in the NATS client.
 *
 *   const publisher = createPublisher({ manifest, schemas });          // checks every declared schema
 *   await publisher.publish(tx, "notes.note.created.v1", data, { subject: id }); // inside YOUR transaction
 *   startAppRelay({ appId, pool });                                    // on boot: outbox → JetStream
 *   subscribe(type, async (event, tx) => {…}, { appId, pool, servers }); // exactly once per event id (inbox)
 */
import { startRelay, type BusAuth, type Relay, type RelayOptions } from "@asafarim/events";
import { natsInboxPrefix, signNatsConnect } from "@asafarim/registry-protocol";
import { consoleLogger } from "./register.ts";

export * from "@asafarim/events";

/**
 * The app's identity on the bus (P4.1 PR 4): user = the app id, password = a fresh signed assertion
 * from ASAFARIM_REGISTRY_CREDENTIAL on every connect and reconnect. Pass it as `auth` to
 * `subscribe()` (and `startRelay()`). Undefined without a credential (a bus that checks nobody).
 */
export function busAuthFromEnv(
  appId: string,
  env: Record<string, string | undefined> = process.env,
): BusAuth | undefined {
  // A plain login for a bus that doesn't use the callout (the integration tests sign in as `core`).
  if (env.ASAFARIM_NATS_USER && env.ASAFARIM_NATS_PASSWORD) {
    const pass = env.ASAFARIM_NATS_PASSWORD;
    return { user: env.ASAFARIM_NATS_USER, pass: () => pass };
  }
  const credential = env.ASAFARIM_REGISTRY_CREDENTIAL;
  if (!credential) return undefined;
  return { user: appId, pass: () => signNatsConnect({ appId, credential }), inboxPrefix: natsInboxPrefix(appId) };
}

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
  const auth = opts.auth ?? busAuthFromEnv(opts.appId, env);
  return startRelay({ ...opts, servers, log, ...(auth ? { auth } : {}) });
}
