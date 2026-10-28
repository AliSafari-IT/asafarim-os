/**
 * Runs once when the server starts: turn on telemetry (P6.2), register with core-api (signed, retried,
 * non-fatal), and with a database: migrate and seed it, start the outbox relay, the subscribers, the
 * timeout sweeper and the retention job (lib/engine/workers.ts).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // First, so the spans of everything after are traced. Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
  const [{ installShutdownFlush, registerTelemetry }, { default: manifest }] = await Promise.all([
    import("@asafarim/telemetry"),
    import("./platform.app"),
  ]);
  // Next.js handles SIGTERM / SIGINT itself; this only starts a bounded flush of the last traces and metrics alongside.
  installShutdownFlush(registerTelemetry({ appId: manifest.id, version: manifest.version }));
  const { getPlatform } = await import("./lib/platform");
  getPlatform();
  if (process.env.DATABASE_URL) {
    const [{ afterCommit, db, engine, startEventRelay, wakeRelay }, { startWorkers }, { log }] = await Promise.all([
      import("./lib/db"),
      import("./lib/engine/workers"),
      import("./lib/log"),
    ]);
    // Migrate and seed now rather than on the first request; a failure is retried on the next use.
    db().catch((err: unknown) => log.warn("db.prepare_failed", { error: (err as Error).message }));
    startEventRelay();
    afterCommit(startWorkers({ pool: db, engine, wake: wakeRelay }).kick);
  } else {
    // Production before `admin.sh install flow` gives it a database: pages and health only, no workflow runs.
    const { log } = await import("./lib/log");
    log.warn("flow.workers.no_database", {
      hint: "DATABASE_URL is not set: no relay, subscribers, sweeper or retention",
    });
  }
}
