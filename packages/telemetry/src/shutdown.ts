/**
 * Flushing on shutdown. Spans wait in the batch processor and metrics accumulate between exports,
 * so a process that stops without flushing loses the last few seconds of both: often the ones
 * that explain why it stopped. `registerTelemetry`'s `shutdown()` is built here: it force-flushes
 * and shuts down the tracer and meter providers, bounded by a timeout, once.
 *
 *   await telemetry.shutdown();         // a service that owns its signals (core-api), before process.exit
 *   installShutdownFlush(telemetry);    // a process whose signals someone else handles (Next.js)
 */
import type { Logger } from "./logger.ts";
import type { Telemetry } from "./register.ts";

/** What a tracer or meter provider offers at shutdown. */
export interface Flushable {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface FlushOptions {
  /** The most the whole flush and shutdown may take, in ms. */
  timeoutMs: number;
  /** Where a failure or the timeout is reported: by error name only, never a message (it may carry a URL). */
  log: Pick<Logger, "warn">;
}

function nameOf(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

async function attempt(step: () => Promise<void>, msg: string, log: FlushOptions["log"]): Promise<void> {
  try {
    await step();
  } catch (err) {
    log.warn(msg, { error: nameOf(err) });
  }
}

/**
 * The shutdown of these providers: each is force-flushed, then shut down, side by side, so one
 * that hangs doesn't hold the other's export back. It resolves within `timeoutMs` whatever the
 * exporters do, returns the same promise on every call, and never rejects.
 */
export function flushThenShutdown(
  providers: readonly Flushable[],
  { timeoutMs, log }: FlushOptions,
): () => Promise<void> {
  let done: Promise<void> | undefined;
  const run = () =>
    Promise.all(
      providers.map(async (provider) => {
        await attempt(() => provider.forceFlush(), "telemetry.flush_failed", log);
        await attempt(() => provider.shutdown(), "telemetry.shutdown_failed", log);
      }),
    ).then(() => undefined);
  return () => {
    if (done) return done;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log.warn("telemetry.shutdown_timeout", { timeoutMs });
        resolve();
      }, timeoutMs);
      // The bound never keeps the process alive on its own.
      timer.unref();
    });
    done = Promise.race([run(), timeout]).finally(() => clearTimeout(timer));
    return done;
  };
}

export interface ShutdownFlushOptions {
  /** The signals to flush on (default SIGTERM and SIGINT). */
  signals?: readonly NodeJS.Signals[];
}

const installed = new Set<NodeJS.Signals>();

/**
 * For a process whose signals something else handles (Next.js's server, which closes and exits on
 * SIGTERM and SIGINT): on the first of these signals, start `telemetry.shutdown()` alongside that
 * handling, and never call `process.exit`. If nothing else listens for the signal, it is raised
 * again once the flush has finished or timed out, so the process still stops as it would have
 * without this listener. Installs at most one listener per signal per process, and none with
 * telemetry off. A service that owns its signal handling awaits `telemetry.shutdown()` itself.
 */
export function installShutdownFlush(
  telemetry: Pick<Telemetry, "enabled" | "shutdown">,
  { signals = ["SIGTERM", "SIGINT"] }: ShutdownFlushOptions = {},
): void {
  if (!telemetry.enabled) return;
  for (const signal of signals) {
    if (installed.has(signal)) continue;
    installed.add(signal);
    process.once(signal, () => {
      // `once` has already removed this listener: what is left is someone else's handling.
      const handledElsewhere = process.listenerCount(signal) > 0;
      void telemetry.shutdown().then(() => {
        if (!handledElsewhere) process.kill(process.pid, signal);
      });
    });
  }
}
