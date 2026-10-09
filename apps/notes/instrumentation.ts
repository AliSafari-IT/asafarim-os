/**
 * Runs once when the server starts: register with core-api (signed, retried, non-fatal), and start
 * the outbox relay (P4.1) when the app has a database and a bus.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getPlatform } = await import("./lib/platform");
  getPlatform();
  if (process.env.DATABASE_URL) {
    const { startEventRelay } = await import("./lib/db");
    startEventRelay();
  }
}
