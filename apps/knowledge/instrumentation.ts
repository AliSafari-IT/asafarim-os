/**
 * Runs once when the server starts: turn on telemetry (P6.2), register with core-api (signed, retried, non-fatal),
 * start the hourly media cleanup (#359), the outbox relay and the nightly engagement recount.
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
  // Uploads nobody finished, and files nobody used for a week, go once an hour (#359). Off without a media store.
  const { scheduleMediaCleanup } = await import("./lib/media/schedule");
  scheduleMediaCleanup();
  if (process.env.DATABASE_URL) {
    // The outbox relay (knowledge.comment.created.v1): off without ASAFARIM_NATS_URL, events then wait in the outbox.
    const { startEventRelay } = await import("./lib/event-relay");
    await startEventRelay();
    // Likes and comments: the nightly recount that heals any drifted count. Off without ENGAGEMENT_SALT.
    const [{ engagementEnabled }, { scheduleEngagementReconcile }, { db }] = await Promise.all([
      import("./lib/engagement-config"),
      import("./lib/engagement-reconcile"),
      import("./lib/db"),
    ]);
    if (engagementEnabled()) scheduleEngagementReconcile(db);
  }
}
