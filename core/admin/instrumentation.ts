/** Runs once when the server starts: turn on telemetry (P6.2). Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // The console is a core service, not an app: no manifest, so its version is its package's (as core-api's).
  const [{ installShutdownFlush, registerTelemetry }, { default: pkg }] = await Promise.all([
    import("@asafarim/telemetry"),
    import("./package.json", { with: { type: "json" } }),
  ]);
  // Next.js handles SIGTERM / SIGINT itself; this only starts a bounded flush of the last traces and metrics alongside.
  installShutdownFlush(registerTelemetry({ appId: "admin", version: pkg.version }));
}
