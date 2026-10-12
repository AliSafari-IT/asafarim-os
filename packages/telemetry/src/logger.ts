/**
 * One JSON line per log call, stamped with the active trace (P6.2): inside a
 * request the line carries `trace_id` and `span_id`, so a log line leads to
 * its trace in the collector and back.
 *
 *   const log = createLogger({ app: "notes" });
 *   log.info("notes listed", { count: notes.length });
 */
import { isSpanContextValid, trace } from "@opentelemetry/api";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  app: string;
  /** Where each line goes; stdout (stderr for warn and error) by default. */
  write?: (line: string, level: LogLevel) => void;
}

function defaultWrite(line: string, level: LogLevel): void {
  (level === "warn" || level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}

/** Errors become `{ name, message }`: no stack, which may carry paths or input. */
function serialise(value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message } : value;
}

export function createLogger({ app, write = defaultWrite }: LoggerOptions): Logger {
  const log = (level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void => {
    const line: Record<string, unknown> = { time: new Date().toISOString(), level, app, msg };
    for (const [key, value] of Object.entries(fields)) line[key] = serialise(value);
    const context = trace.getActiveSpan()?.spanContext();
    if (context && isSpanContextValid(context)) {
      line.trace_id = context.traceId;
      line.span_id = context.spanId;
    }
    write(JSON.stringify(line), level);
  };
  return {
    debug: (msg, fields) => log("debug", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
  };
}
