/**
 * Which durable consumers an install or a registration (an upgrade) has to add and remove (P4.1,
 * ADR 0001 §5). Pure: it reads manifests, never the bus. The registry runs the plan against the bus
 * (registry.ts), bus first, then the write.
 *
 *  - `own`: every type the app subscribes to now (ensure its consumer; idempotent);
 *  - `remove`: every type the previous manifest subscribed to and the new one doesn't (delete its
 *    consumer, so a dropped subscription stops receiving);
 *  - `dependents`: when the app publishes, every OTHER installed app whose current manifest
 *    subscribes to a type this app declares. Those subscribers may have been installed before their
 *    publisher (their consumer was `waiting_for_publisher`), so they get their consumer now.
 */

/** The part of a manifest this module reads. */
export interface EventsManifest {
  events?: {
    publishes?: { type: string }[];
    subscribes?: { type: string }[];
  };
}

/** An installed app (state ≠ removed) and its current manifest, as core-api stores it. */
export interface InstalledApp {
  id: string;
  manifest: EventsManifest | null;
}

export interface ConsumerRef {
  app: string;
  type: string;
}

export interface EventPlumbingPlan {
  /** The app declares `events.publishes`: ensure its stream first. */
  stream: boolean;
  own: string[];
  remove: string[];
  dependents: ConsumerRef[];
}

const uniqueSorted = (xs: string[]) => [...new Set(xs)].sort();

export const subscribedTypes = (m: EventsManifest | null | undefined) =>
  uniqueSorted((m?.events?.subscribes ?? []).map((s) => s.type));

export const publishedTypes = (m: EventsManifest | null | undefined) =>
  uniqueSorted((m?.events?.publishes ?? []).map((p) => p.type));

export function planEventPlumbing(input: {
  appId: string;
  manifest: EventsManifest;
  /** The manifest the app had before this registration; null/undefined at install. */
  previous?: EventsManifest | null;
  /** The OTHER installed apps (this one is skipped if present). */
  installed: InstalledApp[];
}): EventPlumbingPlan {
  const published = publishedTypes(input.manifest);
  const own = subscribedTypes(input.manifest);
  const keep = new Set(own);
  const remove = subscribedTypes(input.previous).filter((t) => !keep.has(t));
  const declared = new Set(published);
  const dependents: ConsumerRef[] = [];
  if (declared.size) {
    for (const app of [...input.installed].sort((a, b) => a.id.localeCompare(b.id))) {
      if (app.id === input.appId) continue;
      for (const type of subscribedTypes(app.manifest)) if (declared.has(type)) dependents.push({ app: app.id, type });
    }
  }
  return { stream: published.length > 0, own, remove, dependents };
}

/**
 * The types `manifest` subscribes to that no installed app (this one included) declares in
 * `events.publishes`: the subscriptions that wait for their publisher. Nothing is blocked; the
 * consumer is created when the publisher is installed. The Admin console shows these as a warning.
 */
export function waitingForPublisher(appId: string, manifest: EventsManifest | null, installed: InstalledApp[]) {
  const published = new Set(publishedTypes(manifest));
  for (const app of installed) if (app.id !== appId) for (const t of publishedTypes(app.manifest)) published.add(t);
  return subscribedTypes(manifest).filter((t) => !published.has(t));
}

/** The per-type outcome of an own subscription: the bus's answer, with `no_stream` named for what it means. */
export const WAITING_FOR_PUBLISHER = "waiting_for_publisher";
export const consumerOutcome = (busResult: string) => (busResult === "no_stream" ? WAITING_FOR_PUBLISHER : busResult);
