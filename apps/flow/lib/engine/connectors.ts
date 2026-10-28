/**
 * Connectors: what a node of a v2 workflow calls outside Flow (email, GitHub: PR 2.5). Each one is
 * registered in process under its node type and declares
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
 * AT LEAST ONCE: a call whose process dies (or whose result can't be written) leaves the step `running`
 * past its lease; the sweeper claims it again and calls the connector again. So a connector may run
 * twice for one step: one that creates something (an issue, a message) carries its own duplicate guard,
 * e.g. an idempotency key made of `ctx.runId`, `ctx.stepId`, never of `ctx.attempt`.
 */
import type { z } from "zod";

export class ConnectorError extends Error {
  override readonly name = "ConnectorError";
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
  }
}

/** The connector's log lines carry the run, the step and the connector type. */
export interface ConnectorLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * The outbound HTTP client (PR 2.3, lib/egress): allow-listed hosts only. Until it lands a connector
 * gets `{ available: false }`.
 */
export type ConnectorEgress = { readonly available: false };
/** The workflow's credentials, by name (PR 2.3). Never written to a step, a log or an audit entry. */
export type ConnectorCredentials = { readonly available: false };

export interface ConnectorContext {
  runId: string;
  stepId: string;
  /** 1 for the first call of the step, + 1 for each call after (a retry, or again after a crash). */
  attempt: number;
  /** A test run (lib/engine/engine.ts `startRun`): the connector may mark what it creates as a test. */
  test: boolean;
  log: ConnectorLogger;
  /** Aborted when the call's time (`timeoutMs`) is up. */
  signal: AbortSignal;
  egress: ConnectorEgress;
  credentials: ConnectorCredentials;
}

export interface Connector<I = unknown, O = unknown> {
  /** The node type, `<app>.<action>` (`email.send`); not one of the built-in node types. */
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

/** The process's connectors. None yet: PR 2.5 registers email and GitHub; the tests register `test.echo`. */
export const connectors: ConnectorRegistry = createConnectorRegistry();
