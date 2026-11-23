/**
 * Runs once when the server starts: turn on telemetry (P6.2), register with core-api (signed, retried, non-fatal),
 * and start the hourly media cleanup (#359).
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
}
