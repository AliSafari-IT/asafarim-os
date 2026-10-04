/**
 * Self-registration on boot (P3.2, ADR 0001 §3): the app POSTs its manifest to
 * core-api, signed with its registry credential. Retried with exponential
 * backoff on network errors and 5xx; stops at once on a 4xx (a bad signature,
 * an unknown app or a namespace violation won't fix itself by retrying).
 * Non-fatal by default, so local development keeps working while core-api
 * starts; pass `strict: true` to throw instead.
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

export async function registerApp(opts: RegisterOptions): Promise<RegisterResult> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? consoleLogger;
  const maxAttempts = opts.maxAttempts ?? 6;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 15_000;
  const path = `/registry/v1/apps/${opts.appId}`;
  const url = `${opts.coreApiUrl.replace(/\/$/, "")}${path}`;
  const body = JSON.stringify(opts.manifest);

  let result: RegisterResult = { ok: false, attempts: 0, error: "unreachable" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result = { ok: false, attempts: attempt, error: "unreachable" };
    try {
      // A fresh signature (timestamp + nonce) for every attempt.
      const headers = {
        "content-type": "application/json",
        ...signRequest({ credential: opts.credential, method: "POST", path, body }),
      };
      const res = await doFetch(url, { method: "POST", headers, body, cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as { state?: string; version?: string; error?: string };
      if (res.ok) {
        result = { ok: true, attempts: attempt, state: json.state, version: json.version };
        log.info("app.registered", { appId: opts.appId, version: json.version, state: json.state, attempts: attempt });
        return result;
      }
      result = { ok: false, attempts: attempt, error: json.error ?? `http_${res.status}` };
      // A refusal below 500 is permanent: stop here instead of hammering core-api.
      if (res.status < 500) break;
    } catch {
      // network error: retry
    }
    if (attempt < maxAttempts) {
      const delay = backoffDelay(attempt, base, max);
      log.warn("app.registration_retry", { appId: opts.appId, attempt, error: result.error, retryInMs: delay });
      await sleep(delay);
    }
  }
  log.warn("app.registration_failed", { appId: opts.appId, attempts: result.attempts, error: result.error });
  if (opts.strict) throw new RegistrationError(result);
  return result;
}
