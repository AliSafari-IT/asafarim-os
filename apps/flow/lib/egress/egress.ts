/**
 * The only way Flow calls out (lint rule and test/egress-boundary.test.ts keep it so). A call is:
 *
 *   1. checked: HTTPS only, no userinfo, port 443 unless its host entry allows another, the host on the
 *      caller's allow-list (a connector's fixed hosts, or the Settings `egress_hosts`), the request body
 *      at most 256 KiB, and Flow not paused (Settings `paused_all`);
 *   2. resolved here, once: every address the name resolves to must be public (lib/egress/address.ts);
 *   3. connected to the address that was checked: the socket's `lookup` is pinned to it, so DNS can't
 *      answer differently between the check and the connection (rebinding); SNI, the certificate check
 *      and the Host header use the name;
 *   4. read: a redirect is never followed (refused), the response at most 1 MiB (then aborted), all of
 *      it within 10 s from the start, DNS included;
 *   5. recorded: one `connector_calls` row (run, step, connector, host, status, duration, error code)
 *      and one log line (method, host, path without its query, status, duration). Never a header or a
 *      body, in either; an error names its code and the host, never the URL.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { LookupFunction } from "node:net";
import { ulid } from "@asafarim/app-sdk/events";
import { log as appLog } from "../log";
import { isPausedAll, type Queryable } from "../settings";
import { isBlockedAddress } from "./address";
import { isAllowed, type AllowedHost } from "./hosts";

export const TIMEOUT_MS = 10_000;
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;

export type EgressErrorCode =
  | "invalid_url"
  | "scheme_refused"
  | "userinfo_refused"
  | "port_refused"
  | "host_not_allowed"
  | "dns_failed"
  | "address_refused"
  | "request_too_large"
  | "response_too_large"
  | "redirect_refused"
  | "timeout"
  | "connect_failed"
  | "paused_all";

export class EgressError extends Error {
  constructor(
    readonly code: EgressErrorCode,
    /** The host the call was for, when the URL got that far. */
    readonly host?: string,
    /** The response's status, when there was one (redirect_refused, response_too_large). */
    readonly status?: number,
  ) {
    super(`Egress ${code}${host ? ` (${host})` : ""}`);
    this.name = "EgressError";
  }
}

export interface EgressRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** The hosts this caller may reach. */
  allow: readonly AllowedHost[];
  /** What the connector_calls row is about. */
  call: { connector: string; runId?: string | null; stepId?: string | null };
}

export interface EgressResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface EgressDeps {
  /** Every address of `host` (default: the system resolver). */
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
  /** Refuse an address (default: isBlockedAddress). Tests reach a local server through it. */
  isBlocked?: (address: string) => boolean;
  /** Extra CA certificates to trust (tests' self-signed server); default: the system's. */
  ca?: string | Buffer;
  timeoutMs?: number;
  log?: {
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
  };
}

const systemResolve = async (host: string): Promise<ResolvedAddress[]> =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));

/**
 * A `lookup` that answers the checked addresses whatever it is asked: the connection goes where the
 * check said. All of them when Node asks for all (it then tries the next one if a family has no route),
 * the first otherwise.
 */
export function pinnedLookup(pinned: readonly ResolvedAddress[]): LookupFunction {
  const first = pinned[0]!;
  return ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (typeof options === "function")
      return (options as (...args: unknown[]) => void)(null, first.address, first.family);
    if (options?.all)
      return callback(
        null,
        pinned.map(({ address, family }) => ({ address, family })),
      );
    return callback(null, first.address, first.family);
  }) as LookupFunction;
}

const REDIRECT = (s: number) => s >= 300 && s < 400 && s !== 304;
/** Headers the caller can't set: egress sets them from the checked URL and the body. */
const OWN_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection"]);

export function createEgress(deps: EgressDeps = {}) {
  const resolve = deps.resolve ?? systemResolve;
  const isBlocked = deps.isBlocked ?? isBlockedAddress;
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const log = deps.log ?? appLog;

  /** Steps 1 and 2: the checked URL and the address to connect to. */
  async function check(q: Queryable, req: EgressRequest) {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw new EgressError("invalid_url");
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") throw new EgressError("scheme_refused", host);
    if (url.username || url.password) throw new EgressError("userinfo_refused", host);
    const port = url.port ? Number(url.port) : 443;
    // An IP literal is never on an allow-list (they hold DNS names), so it stops here.
    const listed = req.allow.some((a) => a.host.toLowerCase() === host);
    if (!listed) throw new EgressError("host_not_allowed", host);
    if (!isAllowed(req.allow, host, port)) throw new EgressError("port_refused", host);
    const size = req.body === undefined ? 0 : Buffer.byteLength(req.body);
    if (size > MAX_REQUEST_BYTES) throw new EgressError("request_too_large", host);
    if (await isPausedAll(q)) throw new EgressError("paused_all", host);
    let addresses: ResolvedAddress[];
    try {
      addresses = await resolve(host);
    } catch {
      throw new EgressError("dns_failed", host);
    }
    if (!addresses.length) throw new EgressError("dns_failed", host);
    // One private answer among public ones is refused too: the name points somewhere it shouldn't.
    if (addresses.some((a) => isBlocked(a.address))) throw new EgressError("address_refused", host);
    return { url, host, port, pinned: addresses, size };
  }

  /** Steps 3 and 4. */
  function send(
    req: EgressRequest,
    c: Awaited<ReturnType<typeof check>>,
    signal: AbortSignal,
  ): Promise<EgressResponse> {
    return new Promise((resolvePromise, reject) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers ?? {})) if (!OWN_HEADERS.has(k.toLowerCase())) headers[k] = v;
      if (req.body !== undefined) headers["content-length"] = String(c.size);
      const r = https.request({
        protocol: "https:",
        host: c.host,
        port: c.port,
        method: req.method,
        path: `${c.url.pathname}${c.url.search}`,
        headers,
        lookup: pinnedLookup(c.pinned),
        // A fresh agent: no pooled socket from another call, the lookup above is used every time.
        agent: false,
        ...(deps.ca ? { ca: deps.ca } : {}),
        signal,
      });
      const fail = (err: EgressError) => {
        r.destroy();
        reject(err);
      };
      r.on("error", () =>
        reject(signal.aborted ? new EgressError("timeout", c.host) : new EgressError("connect_failed", c.host)),
      );
      r.on("response", (res) => {
        const status = res.statusCode ?? 0;
        if (REDIRECT(status)) return fail(new EgressError("redirect_refused", c.host, status));
        if (Number(res.headers["content-length"] ?? 0) > MAX_RESPONSE_BYTES)
          return fail(new EgressError("response_too_large", c.host, status));
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) return fail(new EgressError("response_too_large", c.host, status));
          chunks.push(chunk);
        });
        res.on("end", () => resolvePromise({ status, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", () =>
          reject(signal.aborted ? new EgressError("timeout", c.host) : new EgressError("connect_failed", c.host)),
        );
      });
      r.end(req.body);
    });
  }

  /** Step 5. A row that can't be written is logged; the call already happened either way. */
  async function record(
    q: Queryable,
    req: EgressRequest,
    host: string | null,
    status: number | null,
    durationMs: number,
    errorCode: string | null,
  ) {
    try {
      await q.query(
        `INSERT INTO connector_calls (id, run_id, step_id, connector, host, status, duration_ms, error_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          ulid(),
          req.call.runId ?? null,
          req.call.stepId ?? null,
          req.call.connector,
          host,
          status,
          durationMs,
          errorCode,
        ],
      );
    } catch (err) {
      log.warn("egress.record_failed", { connector: req.call.connector, error: (err as Error).message });
    }
  }

  /** Make one outbound call; an EgressError when it was refused or failed. */
  async function request(q: Queryable, req: EgressRequest): Promise<EgressResponse> {
    const started = performance.now();
    let host: string | null = null;
    let path: string | null = null;
    try {
      const u = new URL(req.url);
      host = u.hostname.toLowerCase();
      path = u.pathname;
    } catch {
      // check() refuses it: invalid_url
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const timedOut = new Promise<never>((_, reject) =>
      controller.signal.addEventListener("abort", () => reject(new EgressError("timeout", host ?? undefined)), {
        once: true,
      }),
    );
    timedOut.catch(() => undefined);
    const fields = { connector: req.call.connector, method: req.method, host, path };
    try {
      const checked = await Promise.race([check(q, req), timedOut]);
      const res = await Promise.race([send(req, checked, controller.signal), timedOut]);
      const durationMs = Math.round(performance.now() - started);
      log.info("egress.call", { ...fields, status: res.status, durationMs });
      await record(q, req, host, res.status, durationMs, null);
      return res;
    } catch (err) {
      const e = err instanceof EgressError ? err : new EgressError("connect_failed", host ?? undefined);
      const durationMs = Math.round(performance.now() - started);
      log.warn("egress.call", { ...fields, status: e.status ?? null, durationMs, errorCode: e.code });
      await record(q, req, host, e.status ?? null, durationMs, e.code);
      throw e;
    } finally {
      clearTimeout(timer);
      // Whatever is still open (a socket after a refusal) is closed.
      controller.abort();
    }
  }

  return { request };
}

export type Egress = ReturnType<typeof createEgress>;
