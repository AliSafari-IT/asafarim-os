/**
 * Runs once when the server starts: turn on telemetry (P6.2), register with core-api (signed, retried, non-fatal), and start
 * the outbox relay and the event subscribers (Flow's requests) when the app has a database and a bus.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // First, so the spans of everything after are traced (P6.2). Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
  const [{ installShutdownFlush, registerTelemetry }, { default: manifest }] = await Promise.all([
    import("@asafarim/telemetry"),
    import("./platform.app"),
  ]);
  // Next.js handles SIGTERM / SIGINT itself; this only starts a bounded flush of the last traces and metrics alongside.
  installShutdownFlush(registerTelemetry({ appId: manifest.id, version: manifest.version }));
  const { getPlatform } = await import("./lib/platform");
  getPlatform();
  if (process.env.DATABASE_URL) {
    const { startEventRelay } = await import("./lib/notes");
    await startEventRelay();
    const { startEventSubscribers } = await import("./lib/subscribers");
    startEventSubscribers();
  }
}
