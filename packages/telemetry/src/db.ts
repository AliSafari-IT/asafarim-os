/**
 * Database spans (ADR 0001 §9, the "database spans" left open by Addenda F and G): each query a
 * traced Postgres client runs inside a traced request becomes a CLIENT span, the child of the
 * request's span.
 *
 *   const pool = traceDatabasePool(new pg.Pool({ connectionString }), { namespace: "core" });
 *
 * What a span carries is an allowlist: `db.system.name` (`postgresql`), `db.operation.name` (the
 * statement's first keyword, from a fixed list: `SELECT`, `INSERT`, `BEGIN`…), `db.namespace`
 * (the database name the caller passed) and, on failure, `error.type` and
 * `db.response.status_code` (the SQLSTATE, e.g. `23505`). Never the SQL text, its parameters, a
 * row or an error message: those may hold user data. The span is named after the operation.
 *
 * Only queries with a recording parent span are traced, so background loops (health polling,
 * the gateway snapshot) don't start a root trace per query, and with telemetry off every query
 * runs exactly as before. Submittables (cursors, streams) and config objects that carry their own
 * callback are passed through untraced.
 *
 * No dependency on `pg`: the client and pool are typed structurally.
 */
import { SpanKind, SpanStatusCode, context, trace, type Attributes } from "@opentelemetry/api";

/**
 * The database name in a Postgres connection URL (its path), for `db.namespace`; undefined when the
 * URL has none or doesn't parse. Only the name is read: never the user, password, host or query.
 */
export function databaseNameOf(url: string): string | undefined {
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
    return name === "" ? undefined : name;
  } catch {
    return undefined;
  }
}

/** The part of a `pg` client this wraps. */
export interface QueryableClient {
  query: (...args: never[]) => unknown;
}

/** The part of a `pg` pool this wraps: it emits `connect` with each new client. */
export interface ConnectingPool<C extends QueryableClient = QueryableClient> {
  on(event: "connect", listener: (client: C) => void): unknown;
}

export interface TraceDatabaseOptions {
  /** The database name (`db.namespace`). Optional; never derived from a connection string here. */
  namespace?: string;
  /** The tracer's name (default "@asafarim/telemetry"). */
  tracerName?: string;
}

export const DB_SYSTEM = "postgresql";

/** Statement keywords recorded as `db.operation.name`; anything else is left out. */
const OPERATIONS: ReadonlySet<string> = new Set([
  "ALTER",
  "ANALYZE",
  "BEGIN",
  "CALL",
  "CLOSE",
  "COMMENT",
  "COMMIT",
  "COPY",
  "CREATE",
  "DEALLOCATE",
  "DECLARE",
  "DELETE",
  "DISCARD",
  "DO",
  "DROP",
  "END",
  "EXECUTE",
  "EXPLAIN",
  "FETCH",
  "GRANT",
  "INSERT",
  "LISTEN",
  "LOCK",
  "MERGE",
  "NOTIFY",
  "PREPARE",
  "REFRESH",
  "REINDEX",
  "RELEASE",
  "RESET",
  "REVOKE",
  "ROLLBACK",
  "SAVEPOINT",
  "SELECT",
  "SET",
  "SHOW",
  "START",
  "TABLE",
  "TRUNCATE",
  "UNLISTEN",
  "UPDATE",
  "VACUUM",
  "VALUES",
  "WITH",
]);

/**
 * The statement's operation: its first keyword after leading whitespace, comments and opening
 * parentheses, upper-cased, if it is in the fixed list; otherwise undefined. Reads at most the
 * first 4 KiB, so a huge statement costs nothing extra.
 */
export function sqlOperation(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const head = text.slice(0, 4096);
  let i = 0;
  for (;;) {
    while (i < head.length && /[\s(;]/.test(head[i] ?? "")) i++;
    if (head.startsWith("--", i)) {
      const nl = head.indexOf("\n", i);
      if (nl === -1) return undefined;
      i = nl + 1;
    } else if (head.startsWith("/*", i)) {
      const close = head.indexOf("*/", i + 2);
      if (close === -1) return undefined;
      i = close + 2;
    } else break;
  }
  const word = /^[A-Za-z]+/.exec(head.slice(i))?.[0]?.toUpperCase();
  return word !== undefined && OPERATIONS.has(word) ? word : undefined;
}

/** A Postgres SQLSTATE: five digits or upper-case letters. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

function failureAttributes(err: unknown): Attributes {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && SQLSTATE.test(code)) return { "error.type": code, "db.response.status_code": code };
  return { "error.type": err instanceof Error ? err.name : "Error" };
}

function queryText(first: unknown): string | undefined {
  if (typeof first === "string") return first;
  if (typeof first === "object" && first !== null) {
    const text = (first as { text?: unknown }).text;
    return typeof text === "string" ? text : undefined;
  }
  return undefined;
}

function untraceable(first: unknown): boolean {
  if (typeof first !== "object" || first === null) return false;
  const q = first as { submit?: unknown; callback?: unknown };
  return typeof q.submit === "function" || typeof q.callback === "function";
}

const TRACED = Symbol.for("@asafarim/telemetry.db-traced");

/**
 * Wrap `client.query` so each query inside a recording span runs in a CLIENT span. Promise and
 * callback forms are both traced; the result, the error and the return value are unchanged.
 * Wrapping the same client twice is a no-op.
 */
export function traceDatabaseClient<C extends QueryableClient>(client: C, opts: TraceDatabaseOptions = {}): C {
  const target = client as C & { [TRACED]?: true };
  if (target[TRACED]) return client;
  const tracerName = opts.tracerName ?? "@asafarim/telemetry";
  const original = client.query as (...args: unknown[]) => unknown;
  const traced = function (this: unknown, ...args: unknown[]): unknown {
    const parentContext = context.active();
    const parent = trace.getSpan(parentContext);
    if (!parent?.isRecording() || untraceable(args[0])) return original.apply(this, args);

    const operation = sqlOperation(queryText(args[0]));
    const attributes: Attributes = { "db.system.name": DB_SYSTEM };
    if (operation !== undefined) attributes["db.operation.name"] = operation;
    if (opts.namespace) attributes["db.namespace"] = opts.namespace;
    const span = trace
      .getTracer(tracerName)
      .startSpan(operation ?? DB_SYSTEM, { kind: SpanKind.CLIENT, attributes }, parentContext);
    let ended = false;
    const end = (err?: unknown) => {
      if (ended) return;
      ended = true;
      if (err) {
        span.setAttributes(failureAttributes(err));
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end();
    };

    const last = args.length - 1;
    const callback = args[last];
    if (typeof callback === "function") {
      args[last] = context.bind(parentContext, function (this: unknown, err: unknown, ...rest: unknown[]) {
        end(err);
        return (callback as (...a: unknown[]) => unknown).call(this, err, ...rest);
      });
    }
    let result: unknown;
    try {
      result = context.with(trace.setSpan(parentContext, span), () => original.apply(this, args));
    } catch (err) {
      end(err);
      throw err;
    }
    if (typeof callback === "function") return result;
    if (result !== null && typeof result === "object" && typeof (result as PromiseLike<unknown>).then === "function") {
      return (result as Promise<unknown>).then(
        (value) => {
          end();
          return value;
        },
        (err: unknown) => {
          end(err);
          throw err;
        },
      );
    }
    end();
    return result;
  };
  Object.defineProperty(target, "query", { value: traced, writable: true, configurable: true });
  Object.defineProperty(target, TRACED, { value: true });
  return client;
}

/**
 * Trace every client the pool connects from now on (`pool.query` and checked-out clients alike).
 * Call it right after creating the pool, before the first query.
 */
export function traceDatabasePool<P extends ConnectingPool>(pool: P, opts: TraceDatabaseOptions = {}): P {
  pool.on("connect", (client) => {
    traceDatabaseClient(client, opts);
  });
  return pool;
}
