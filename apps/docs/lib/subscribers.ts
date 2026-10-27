import "server-only";
/**
 * The events Docs consumes (Flow, ADR 0001), started once per process on boot (instrumentation.ts)
 * when the app has a database and a bus: one subscriber per `events.subscribes` type. The SDK's
 * `subscribe` runs each handler exactly once per event id, in a transaction of Docs's database that
 * also holds the inbox row and whatever the handler writes to the outbox; the relay is woken once it
 * committed. Only instrumentation.ts imports this file, so no page loads the event SDK.
 */
import { busAuthFromEnv, subscribe, type EventHandler, type Subscription } from "@asafarim/app-sdk/events";
import { traceEventHandler } from "@asafarim/telemetry";
import manifest from "../platform.app";
import { createIssueCreateHandler, ISSUE_APPROVED } from "./issue-create-handler";
import { createIssueDraftHandler, ISSUE_DRAFT_REQUESTED } from "./issue-draft-handler";
import { migratedPool, wakeEventRelay } from "./notes";

/** The handler of each type the manifest subscribes to. */
const HANDLERS: Record<string, () => EventHandler> = {
  [ISSUE_DRAFT_REQUESTED]: () => createIssueDraftHandler(),
  [ISSUE_APPROVED]: () => createIssueCreateHandler(),
};

const g = globalThis as unknown as { docsSubscriptions?: Subscription[] };

export function startEventSubscribers(env: Record<string, string | undefined> = process.env): Subscription[] {
  if (g.docsSubscriptions) return g.docsSubscriptions;
  const pool = migratedPool();
  const servers = env.ASAFARIM_NATS_URL?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!pool || !servers?.length) {
    console.warn(
      JSON.stringify({
        app: "docs",
        level: "warn",
        msg: "events.subscribers.not_started",
        hint: "DATABASE_URL and ASAFARIM_NATS_URL are both needed: Flow's requests wait on the bus",
      }),
    );
    return (g.docsSubscriptions = []);
  }
  const auth = busAuthFromEnv(manifest.id, env);
  g.docsSubscriptions = (manifest.events?.subscribes ?? []).map(({ type }) => {
    const handler = HANDLERS[type];
    if (!handler) throw new Error(`docs: no handler for the subscribed event ${type}`);
    return subscribe(type, traceEventHandler(handler()), {
      appId: manifest.id,
      pool,
      servers,
      ...(auth ? { auth } : {}),
      onDelivery: (outcome) => {
        if (outcome === "processed") wakeEventRelay();
      },
    });
  });
  return g.docsSubscriptions;
}
