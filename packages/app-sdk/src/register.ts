/**
 * Self-registration on boot (P3.2, ADR 0001 §3): the app POSTs its manifest to
 * core-api, signed with its registry credential. Retried with exponential
 * backoff on network errors and 5xx; stops at once on a 4xx (a bad signature,
 * an unknown app or a namespace violation won't fix itself by retrying).
 * Non-fatal by default, so local development keeps working while core-api
 * starts; pass `strict: true` to throw instead.
 *
 * P4.2: given the JSON Schemas of what it publishes (`schemas`, the same map `createPublisher` takes),
 * the app then uploads them for the event catalog (signed `PUT /registry/v1/apps/<id>/event-schemas`),
 * with the same retry and backoff. A failed upload is logged and never fatal, even with `strict`:
 * the app works without it, and the catalog shows the type's schema as `not_provided`.
 */
import { signRequest } from "@asafarim/registry-protocol";

export interface SdkLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: SdkLogger = {
  info: (msg, fields) => console.log(JSON.stringify({ sdk: "app-sdk", level: "info", msg, ...fields })),
  warn: (msg, fields) => console.warn(JSON.stringify({ sdk: "app-sdk", level: "warn", msg, ...fields })),
};

export interface RegisterOptions {
  appId: string;
  /** `osk1.…`, issued once at install. */
  credential: string;
  coreApiUrl: string;
  /** The manifest, exactly as it should be registered (JSON-serialisable). */
  manifest: unknown;
  /**
   * The JSON Schemas of the published events, keyed by the path the manifest references
   * (`events.publishes[].schema`): uploaded for the event catalog after a successful registration.
   */
  schemas?: Record<string, object>;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Throw instead of resolving `{ ok: false }` once registration has failed. */
  strict?: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: SdkLogger;
}

export interface RegisterResult {
  ok: boolean;
  attempts: number;
  /** The app's lifecycle state as core-api reports it (installed | active | inactive). */
  state?: string;
  version?: string;
  /** core-api's error code for a refusal (e.g. `bad_signature`), or `unreachable`. */
  error?: string;
  /** The event-schema upload (P4.2): only when `schemas` was given, registration succeeded and the app publishes. */
  schemas?: SchemaUploadResult;
}

export interface SchemaUploadResult {
  ok: boolean;
  attempts: number;
  /** The types uploaded (core-api's answer). */
  types?: string[];
  /** core-api's error code (e.g. `invalid_event_schemas`), `unreachable`, or `missing_schema` (none given for a published type's path). */
  error?: string;
}

export class RegistrationError extends Error {
  readonly result: RegisterResult;
  constructor(result: RegisterResult) {
    super(`registration failed: ${result.error ?? "unknown"} after ${result.attempts} attempt(s)`);
    this.name = "RegistrationError";
    this.result = result;
  }
}

/** Delay before retry `n` (1-based): base · 2^(n-1), capped, with up to 25% jitter. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp * (1 + 0.25 * random()));
}

interface SignedSendOptions {
  credential: string;
  coreApiUrl: string;
  method: string;
  path: string;
  body: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Called before each retry. */
  onRetry: (attempt: number, error: string | undefined, retryInMs: number) => void;
}

type SignedSendResult = { ok: boolean; attempts: number; json: Record<string, unknown>; error?: string };

/**
 * Send one signed request to core-api, retried with backoff on network errors and 5xx, stopping
 * at once on a 4xx (permanent). A fresh signature (timestamp + nonce) for every attempt.
 */
async function sendSigned(o: SignedSendOptions): Promise<SignedSendResult> {
  const url = `${o.coreApiUrl.replace(/\/$/, "")}${o.path}`;
  let result: SignedSendResult = { ok: false, attempts: 0, json: {}, error: "unreachable" };
  for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
    result = { ok: false, attempts: attempt, json: {}, error: "unreachable" };
    try {
      const headers = {
        "content-type": "application/json",
        ...signRequest({ credential: o.credential, method: o.method, path: o.path, body: o.body }),
      };
      const res = await o.fetch(url, { method: o.method, headers, body: o.body, cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) return { ok: true, attempts: attempt, json };
      result = {
        ok: false,
        attempts: attempt,
        json,
        error: typeof json.error === "string" ? json.error : `http_${res.status}`,
      };
      // A refusal below 500 is permanent: stop here instead of hammering core-api.
      if (res.status < 500) break;
    } catch {
      // network error: retry
    }
    if (attempt < o.maxAttempts) {
      const delay = backoffDelay(attempt, o.baseDelayMs, o.maxDelayMs);
      o.onRetry(attempt, result.error, delay);
      await o.sleep(delay);
    }
  }
  return result;
}

/** The published types and their schema paths, read from a manifest that is only known to be JSON. */
function publishedSchemaPaths(manifest: unknown): { type: string; schema: string }[] {
  const publishes = (manifest as { events?: { publishes?: unknown } } | null)?.events?.publishes;
  if (!Array.isArray(publishes)) return [];
  return publishes.filter(
    (p): p is { type: string; schema: string } =>
      typeof (p as { type?: unknown })?.type === "string" && typeof (p as { schema?: unknown })?.schema === "string",
  );
}

export async function registerApp(opts: RegisterOptions): Promise<RegisterResult> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? consoleLogger;
  const retry = {
    credential: opts.credential,
    coreApiUrl: opts.coreApiUrl,
    maxAttempts: opts.maxAttempts ?? 6,
    baseDelayMs: opts.baseDelayMs ?? 500,
    maxDelayMs: opts.maxDelayMs ?? 15_000,
    fetch: doFetch,
    sleep,
  };
  const path = `/registry/v1/apps/${encodeURIComponent(opts.appId)}`;

  const sent = await sendSigned({
    ...retry,
    method: "POST",
    path,
    body: JSON.stringify(opts.manifest),
    onRetry: (attempt, error, retryInMs) =>
      log.warn("app.registration_retry", { appId: opts.appId, attempt, error, retryInMs }),
  });
  if (!sent.ok) {
    const result: RegisterResult = { ok: false, attempts: sent.attempts, error: sent.error };
    log.warn("app.registration_failed", { appId: opts.appId, attempts: result.attempts, error: result.error });
    if (opts.strict) throw new RegistrationError(result);
    return result;
  }
  const state = sent.json.state as string | undefined;
  const version = sent.json.version as string | undefined;
  log.info("app.registered", { appId: opts.appId, version, state, attempts: sent.attempts });
  const result: RegisterResult = { ok: true, attempts: sent.attempts, state, version };

  const published = publishedSchemaPaths(opts.manifest);
  if (!opts.schemas || published.length === 0) return result;

  // Each published type's schema, by the path the manifest references.
  const byType: Record<string, object> = {};
  const missing: string[] = [];
  for (const { type, schema } of published) {
    const json = opts.schemas[schema];
    if (json) byType[type] = json;
    else missing.push(type);
  }
  if (missing.length) {
    result.schemas = { ok: false, attempts: 0, error: "missing_schema" };
    log.warn("app.event_schemas_failed", { appId: opts.appId, error: "missing_schema", types: missing });
    return result;
  }
  const upload = await sendSigned({
    ...retry,
    method: "PUT",
    path: `${path}/event-schemas`,
    body: JSON.stringify({ schemas: byType }),
    onRetry: (attempt, error, retryInMs) =>
      log.warn("app.event_schemas_retry", { appId: opts.appId, attempt, error, retryInMs }),
  });
  if (upload.ok) {
    const types = upload.json.types as string[] | undefined;
    result.schemas = { ok: true, attempts: upload.attempts, types };
    log.info("app.event_schemas_uploaded", { appId: opts.appId, types, attempts: upload.attempts });
  } else {
    // Never fatal: the app works without it; the catalog shows the schema as not provided.
    result.schemas = { ok: false, attempts: upload.attempts, error: upload.error };
    log.warn("app.event_schemas_failed", { appId: opts.appId, attempts: upload.attempts, error: upload.error });
  }
  return result;
}
