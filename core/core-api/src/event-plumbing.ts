/**
 * Which durable consumers an install or a registration (an upgrade) has to add and remove (P4.1,
 * ADR 0001 §5). Pure: it reads manifests, never the bus. The registry runs the plan against the bus
 * (registry.ts), bus first, then the write.
 *
 *  - `own`: every type the app subscribes to now (ensure its consumer; idempotent), except a type in
 *    its OWN namespace that the new manifest doesn't publish (a self-subscribing publisher that
 *    stopped publishing it): nobody else may publish `<id>.*`, so that subscription waits for a
 *    publisher, and its consumer goes (it is in `remove`);
 *  - `remove`: every type the previous manifest subscribed to that isn't in `own` (delete its
 *    consumer, so a dropped subscription stops receiving), plus the own-namespace types above, every
 *    time (deleting an absent consumer is `absent`, so repeated registrations never flip it);
 *  - `dependents`: when the app publishes, every OTHER installed app whose current manifest
 *    subscribes to a type this app declares. Those subscribers may have been installed before their
 *    publisher (their consumer was `waiting_for_publisher`), so they get their consumer now;
 *  - `orphaned`: when an upgrade drops a type from `events.publishes`, every OTHER installed app
 *    whose current manifest subscribes to it. Their consumer on this app's stream filters on a
 *    subject that gets no new messages: it is deleted, and the subscription waits for a publisher
 *    again. If the publisher re-adds the type later, `dependents` creates the consumer again.
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
  /** Other installed apps' consumers of the types this upgrade stops publishing: delete them. */
  orphaned: ConsumerRef[];
}

const uniqueSorted = (xs: string[]) => [...new Set(xs)].sort();

export const subscribedTypes = (m: EventsManifest | null | undefined) =>
  uniqueSorted((m?.events?.subscribes ?? []).map((s) => s.type));

export const publishedTypes = (m: EventsManifest | null | undefined) =>
  uniqueSorted((m?.events?.publishes ?? []).map((p) => p.type));

/** `type` is in `appId`'s namespace (`<appId>.…`): only that app may publish it. */
export const inNamespace = (appId: string, type: string) => type.startsWith(`${appId}.`);

export function planEventPlumbing(input: {
  appId: string;
  manifest: EventsManifest;
  /** The manifest the app had before this registration; null/undefined at install. */
  previous?: EventsManifest | null;
  /** The OTHER installed apps (this one is skipped if present). */
  installed: InstalledApp[];
}): EventPlumbingPlan {
  const published = publishedTypes(input.manifest);
  const declared = new Set(published);
  const subscribed = subscribedTypes(input.manifest);
  const selfWaiting = subscribed.filter((t) => inNamespace(input.appId, t) && !declared.has(t));
  const own = subscribed.filter((t) => !selfWaiting.includes(t));
  const keep = new Set(own);
  const remove = uniqueSorted([...subscribedTypes(input.previous).filter((t) => !keep.has(t)), ...selfWaiting]);
  const dropped = new Set(publishedTypes(input.previous).filter((t) => !declared.has(t)));
  const dependents: ConsumerRef[] = [];
  const orphaned: ConsumerRef[] = [];
  if (declared.size || dropped.size) {
    for (const app of [...input.installed].sort((a, b) => a.id.localeCompare(b.id))) {
      if (app.id === input.appId) continue;
      for (const type of subscribedTypes(app.manifest)) {
        if (declared.has(type)) dependents.push({ app: app.id, type });
        else if (dropped.has(type)) orphaned.push({ app: app.id, type });
      }
    }
  }
  return { stream: published.length > 0, own, remove, dependents, orphaned };
}

/** What removing an app (ADR 0001 §3 step 6) does on the bus. Run in this order, bus first. */
export interface RemovalPlan {
  /** The app's own consumers: every type its manifest subscribes to. */
  own: string[];
  /**
   * The OTHER installed apps' consumers on this app's stream: every type in its namespace they
   * subscribe to (what it publishes, and anything else in `<id>.*`). Their subscriptions wait for a
   * publisher again.
   */
  dependents: ConsumerRef[];
  /**
   * Delete the app's stream `APP_<ID>`, always (idempotent: `absent` when it has none). An upgrade
   * that stopped publishing everything leaves the stream in place, so the current manifest can't
   * tell whether there is one; with it go its messages, so a reinstall never re-delivers them.
   */
  stream: true;
}

/** Pure, like planEventPlumbing: the bus steps that remove `appId`. `installed` = the OTHER installed apps. */
export function planRemoval(input: {
  appId: string;
  manifest: EventsManifest | null;
  installed: InstalledApp[];
}): RemovalPlan {
  const dependents: ConsumerRef[] = [];
  for (const app of [...input.installed].sort((a, b) => a.id.localeCompare(b.id))) {
    if (app.id === input.appId) continue;
    for (const type of subscribedTypes(app.manifest))
      if (inNamespace(input.appId, type)) dependents.push({ app: app.id, type });
  }
  return { own: subscribedTypes(input.manifest), dependents, stream: true };
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
