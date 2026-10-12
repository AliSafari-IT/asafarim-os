#!/usr/bin/env node
/**
 * `pnpm dev:telemetry` (P6.2): start the local OpenTelemetry collector
 * (compose.dev.yml, profile "telemetry") and follow its log, which prints every
 * span and metric the apps send. In another terminal, run the OS with the apps
 * pointed at it:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 pnpm dev
 *
 * Ctrl+C stops following; the collector keeps running until `docker compose
 * -f compose.dev.yml --profile telemetry stop otel-collector` (or a reboot).
 */
import { spawnSync } from "node:child_process";
import { bold, compose, COMPOSE, dim, requireDocker } from "./infra.mjs";

requireDocker();
compose("--profile", "telemetry", "up", "-d", "otel-collector");
console.log(`${bold("The OpenTelemetry collector listens on http://127.0.0.1:4318.")}
Run the OS with ${bold("OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 pnpm dev")} to send it traces and metrics.
${dim("Following its log (Ctrl+C stops following, not the collector):")}`);
// Not compose(): Ctrl+C ends `logs --follow` with a signal, which is how this is meant to stop.
spawnSync("docker", [...COMPOSE, "--profile", "telemetry", "logs", "--follow", "--tail", "20", "otel-collector"], {
  stdio: "inherit",
});
