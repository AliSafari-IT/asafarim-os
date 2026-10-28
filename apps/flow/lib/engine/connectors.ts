/**
 * Connectors: what a node of a v2 workflow calls outside Flow (email, GitHub, webhook out: lib/connectors).
 * Each one is registered in process under its node type and declares
 *
 * - `input` and `output` (Zod): the node's `input` is checked against `input` when the definition is
 *   validated and again once its placeholders are filled; what `run` returns must fit `output`;
 * - `simulate(input)`: the output a dry run records instead of calling it;
 * - `run(ctx, input)`: the call. It throws `ConnectorError(code, retryable, message)` when it fails;
 *   anything else it throws counts as a retryable `connector_error`.
 *
 * How the engine calls one (lib/engine/engine.ts): the step is `pending` until a worker claims it, then
 * `running` while the call is in flight, outside any transaction. The result (or the error code) is
 * written in one transaction with the next transition. A retryable failure is tried again after 5 s,
 * 30 s, then 2 min; after that the step fails.
 *
 * What a connector reaches the world with is in its context, never imported: `egress` (lib/egress, the
 * only way out over HTTPS), `smtp` (email, with the same checks), `credentials` (decrypted when used,
 * with the pool: outside the run's transaction, like the call) and `db` (the pool, for a connector's own
 * bookkeeping such as email's rate limit). The production ones come from `services` (lib/db.ts).
 *
 * AT LEAST ONCE: a call whose process dies (or whose result can't be written) leaves the step `running`
 * past its lease; the sweeper claims it again and calls the connector again. So a connector may run
 * twice for one step: one that creates something (an issue, a message) carries its own duplicate guard,
 * e.g. an idempotency key made of `ctx.runId`, `ctx.stepKey`, never of `ctx.attempt`.
 */
import type pg from "pg";
import type { z } from "zod";
import { CredentialError, useCredential, type CredentialKind, type CredentialOf } from "../credentials/store";
import type { Keyring } from "../credentials/cipher";
import type { EgressRequest, EgressResponse } from "../egress/egress";
import type { MailRequest } from "../egress/smtp";
import type { Queryable } from "../settings";
import { BUILTIN_CONNECTORS } from "../connectors";
import { ConnectorError } from "./connector-error";

export { ConnectorError };

/** The connector's log lines carry the run, the step and the connector type. */
export interface ConnectorLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/** lib/egress for this call: recorded against the run and the step. Throws EgressError. */
export interface ConnectorEgress {
  request(req: Omit<EgressRequest, "call">): Promise<EgressResponse>;
}
/**
 * The credential store: `use(id, kind)` decrypts one when the call needs it. Never written to a step,
 * a log or an audit entry. A ConnectorError, not retryable, with the store's code (credentials_unavailable
 * when FLOW_CREDENTIALS_KEY is missing or invalid, credential_not_found, …) when it can't.
 */
export interface ConnectorCredentials {
  use<K extends CredentialKind>(id: string, kind: K): Promise<CredentialOf[K]>;
}
/** Email out (lib/egress/smtp.ts) for this call. Throws SmtpEgressError. */
export interface ConnectorSmtp {
  send(req: Omit<MailRequest, "call">): Promise<{ messageId?: string }>;
}
/** The pool (no transaction is open); `transaction` runs `fn` in one. */
export interface ConnectorDb extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

export interface ConnectorContext {
  runId: string;
  /** The workflow the run belongs to. */
  workflowId: string;
  /** When the run started: never later than the step's first call (a duplicate guard looks from here). */
  runStartedAt: Date;
  stepId: string;
  /** The step's key in the definition: with `runId`, the same for every call of the step. */
  stepKey: string;
  /** 1 for the first call of the step, + 1 for each call after (a retry, or again after a crash). */
  attempt: number;
  /** A test run (lib/engine/engine.ts `startRun`): the connector may mark what it creates as a test. */
  test: boolean;
  log: ConnectorLogger;
  /** Aborted when the call's time (`timeoutMs`) is up. */
  signal: AbortSignal;
  egress: ConnectorEgress;
  credentials: ConnectorCredentials;
  smtp: ConnectorSmtp;
  db: ConnectorDb;
}

export interface Connector<I = unknown, O = unknown> {
  /** The node type, `<app>.<action>` (`email.send`, `github.issue.create`); not a built-in node type. */
  type: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  /** What a dry run returns for `input`, without calling anything. */
  simulate(input: I): O;
  run(ctx: ConnectorContext, input: I): Promise<O>;
  /** How long one call may take; 30 s when not set. */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ConnectorRegistry {
  register<I, O>(connector: Connector<I, O>): void;
  get(type: string): Connector | undefined;
  types(): string[];
}

export function createConnectorRegistry(): ConnectorRegistry {
  const byType = new Map<string, Connector>();
  return {
    register(connector) {
      if (byType.has(connector.type)) throw new Error(`connector ${connector.type} is registered already`);
      byType.set(connector.type, connector as Connector);
    },
    get: (type) => byType.get(type),
    types: () => [...byType.keys()].sort(),
  };
}

/** The process's connectors: the built-in ones (lib/connectors); the tests add `test.echo`. */
export const connectors: ConnectorRegistry = createConnectorRegistry();
for (const c of BUILTIN_CONNECTORS) connectors.register(c);

/** What the engine builds each call's context from; lib/db.ts gives the production ones. */
export interface ConnectorServices {
  db(): Promise<ConnectorDb>;
  egress: { request(q: Queryable, req: EgressRequest): Promise<EgressResponse> };
  smtp: { send(q: Queryable, req: MailRequest): Promise<{ messageId?: string }> };
  /** FLOW_CREDENTIALS_KEY and the keys before it; undefined when missing or invalid. */
  keyring(): Keyring | undefined;
}

/** Without services (the engine's unit tests): any use of them fails the call, not retryable. */
export const NO_SERVICES: ConnectorServices = {
  db: () => Promise.reject(new ConnectorError("services_unavailable", false, "No database for connectors.")),
  egress: { request: () => Promise.reject(new ConnectorError("services_unavailable", false, "No egress.")) },
  smtp: { send: () => Promise.reject(new ConnectorError("services_unavailable", false, "No SMTP.")) },
  keyring: () => undefined,
};

/** A pool as a connector's `db`. */
export function poolDb(pool: pg.Pool): ConnectorDb {
  return {
    query: (text: string, values?: unknown[]) => pool.query(text, values),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  } as ConnectorDb;
}

/** The services a call reaches the world with, bound to its run and step. Nothing is opened until used. */
export function servicesFor(
  services: ConnectorServices,
  call: { connector: string; runId: string; stepId: string },
): Pick<ConnectorContext, "db" | "egress" | "smtp" | "credentials"> {
  const db: ConnectorDb = {
    query: async (text: string, values?: unknown[]) => (await services.db()).query(text, values),
    transaction: async (fn) => (await services.db()).transaction(fn),
  } as ConnectorDb;
  return {
    db,
    egress: { request: (req) => services.egress.request(db, { ...req, call }) },
    smtp: { send: (req) => services.smtp.send(db, { ...req, call }) },
    credentials: {
      async use(id, kind) {
        try {
          return await useCredential(db, id, kind, services.keyring());
        } catch (err) {
          if (err instanceof CredentialError) throw new ConnectorError(err.code, false, err.message);
          throw err;
        }
      },
    },
  };
}
