/** Pure helpers for the Events page (unit-tested in test/events.test.ts). */
import type { CatalogEntry } from "./core-api";
import { isAppId } from "./util";

/** The `?app=` filter as the page applies it: a valid app id, or nothing (an invalid value is ignored). */
export function eventsAppFilter(raw: unknown): string | undefined {
  return isAppId(raw) ? raw : undefined;
}

/** The catalog sorted by type, keeping only the types `app` publishes or subscribes to (when given). */
export function catalogFor(entries: CatalogEntry[], app?: string): CatalogEntry[] {
  return entries
    .filter((e) => !app || e.publisher?.appId === app || e.subscribers.some((s) => s.appId === app))
    .slice()
    .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}

export interface EntryFlags {
  /** Nobody installed publishes the type: every subscription to it is dangling. */
  noPublisher: boolean;
  /** The subscribers whose durable consumer waits for a publisher. */
  waiting: string[];
}

/** What the page flags for one entry. */
export function entryFlags(entry: CatalogEntry): EntryFlags {
  return {
    noPublisher: entry.publisher === null || entry.schemaStatus === "no_publisher",
    waiting: entry.subscribers.filter((s) => s.consumer === "waiting_for_publisher").map((s) => s.appId),
  };
}

/** The schema as pretty-printed JSON text (rendered as text, never as HTML). */
export function schemaText(schema: object | null): string {
  return schema === null ? "" : JSON.stringify(schema, null, 2);
}
