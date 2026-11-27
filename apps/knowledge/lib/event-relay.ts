/**
 * The outbox relay: once per process (started on boot, instrumentation.ts), it sends what the outbox holds to the
 * bus, including events an earlier run left there. Without DATABASE_URL or ASAFARIM_NATS_URL there is none, and
 * events wait in the outbox (one log line says so).
 */
import type { Relay } from "@asafarim/app-sdk/events";
import manifest from "../platform.app";
import { db } from "./db";

const g = globalThis as unknown as { knowledgeRelay?: Relay | null };

export async function startEventRelay(): Promise<Relay | undefined> {
  if (g.knowledgeRelay === undefined) {
    const { startAppRelay } = await import("@asafarim/app-sdk/events");
    g.knowledgeRelay ??= process.env.DATABASE_URL ? (startAppRelay({ appId: manifest.id, pool: db }) ?? null) : null;
  }
  return g.knowledgeRelay ?? undefined;
}

/** Send what a committed transaction wrote to the outbox now, not at the relay's next poll. */
export const wakeEventRelay = (): void => g.knowledgeRelay?.wake();
