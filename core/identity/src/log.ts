/**
 * JSON-lines logging. Callers pass only ids, codes and counts: never tokens,
 * authorization codes, tickets, assertions, cookies, emails or names. `safe`
 * strips any field whose name looks like one of those, as a second line of
 * defence.
 */
type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, string | number | boolean | null | undefined>;

const FORBIDDEN = /token|code|ticket|assertion|secret|password|cookie|email|name|jwt|authorization/i;
const ALLOWED = new Set(["errorCode", "clientId", "uid", "event", "status", "path", "method", "durationMs", "reason"]);

export function safe(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (ALLOWED.has(k) || !FORBIDDEN.test(k)) out[k] = v;
  }
  return out;
}

export type Logger = Record<Level, (msg: string, fields?: Fields) => void>;

export function createLogger(write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Logger {
  const at =
    (level: Level) =>
    (msg: string, fields: Fields = {}) =>
      write(JSON.stringify({ level, time: new Date().toISOString(), service: "identity", msg, ...safe(fields) }));
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
