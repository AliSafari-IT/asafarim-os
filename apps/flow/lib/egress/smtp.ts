/**
 * Email out (the `email.send` connector): SMTP isn't HTTPS, so it doesn't go through `request`
 * (egress.ts), but it is held to the same rules there:
 *
 *   1. Flow not paused (Settings `paused_all`);
 *   2. the server's name resolved here, once: every address must be public (address.ts), and the
 *      connection is pinned to them (no rebinding), the certificate checked against the name;
 *   3. `none` (no TLS) only for a loopback server, and never with NODE_ENV=production; then no AUTH;
 *   4. one `connector_calls` row and one log line per call (host, duration, error code): never an
 *      address, the subject, the body or a credential.
 *
 * Errors are an SmtpEgressError with a code the connector reports as is (smtp_auth, smtp_unavailable,
 * …) and whether trying again may help.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ulid } from "@asafarim/app-sdk/events";
import { addressOf, SmtpClient, SmtpError, type SmtpConfig, type SmtpMessage, type SmtpResult } from "@asafarim/smtp";
import { log as appLog } from "../log";
import { isPausedAll, type Queryable } from "../settings";
import { isBlockedAddress } from "./address";
import { pinnedLookup, type EgressRoute, type ResolvedAddress } from "./egress";

/** The whole call, DNS and every SMTP step included. */
export const SMTP_TIMEOUT_MS = 20_000;

export type SmtpEgressErrorCode =
  | "paused_all"
  | "dns_failed"
  | "private_address"
  /** `none` for a host that isn't loopback, or in production. */
  | "insecure_refused"
  | "smtp_auth"
  | "smtp_unavailable"
  /** A permanent (5xx) answer to the sender, a recipient or the message. */
  | "smtp_rejected"
  /** STARTTLS missing, or the TLS handshake (the certificate) failed. */
  | "smtp_tls"
  /** Refused before connecting: a line break in a header, an address that isn't one. */
  | "invalid_message";

const RETRYABLE: ReadonlySet<SmtpEgressErrorCode> = new Set(["dns_failed", "smtp_unavailable"]);

export class SmtpEgressError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: SmtpEgressErrorCode,
    readonly host?: string,
  ) {
    super(`SMTP ${code}${host ? ` (${host})` : ""}`);
    this.name = "SmtpEgressError";
    this.retryable = RETRYABLE.has(code);
  }
}

export interface MailRequest {
  /** From the smtp credential: its meta (host, port, mode) and its secret. */
  server: { host: string; port: number; mode: "starttls" | "tls" | "none"; username: string; password: string };
  message: SmtpMessage;
  call: { connector: string; runId?: string | null; stepId?: string | null };
}

export interface SmtpEgressDeps {
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
  /** A host the e2e serves locally (lib/egress/e2e.ts): where its connection goes, and the CA it proves its name with. */
  route?: (host: string, port: number) => EgressRoute | undefined;
  isBlocked?: (address: string) => boolean;
  env?: Record<string, string | undefined>;
  /** The SMTP conversation (default: @asafarim/smtp). Tests talk to a local server through it. */
  send?: (config: SmtpConfig, message: SmtpMessage) => Promise<SmtpResult>;
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

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** 127.0.0.0/8, ::1 and ::ffff:127.x.y.z. */
export function isLoopbackAddress(address: string): boolean {
  const a = address.toLowerCase();
  if (isIP(a) === 4) return a.startsWith("127.");
  return a === "::1" || a === "0:0:0:0:0:0:0:1" || /^::ffff:127\.\d+\.\d+\.\d+$/.test(a);
}

/** What an SmtpError's reason (a step name, or `<step>_<reply code>`) means for the connector. */
export function codeOfSmtpReason(reason: string): SmtpEgressErrorCode {
  if (/^auth_\d{3}$/.test(reason)) return "smtp_auth";
  if (["header_injection", "bad_address", "no_recipient"].includes(reason)) return "invalid_message";
  if (["tls", "starttls_unavailable", "starttls_pipelining", "auth_without_tls"].includes(reason)) return "smtp_tls";
  if (/^starttls_\d{3}$/.test(reason)) return "smtp_tls";
  if (/_5\d\d$/.test(reason)) return "smtp_rejected";
  // A 4xx answer, the connection lost or refused, no answer in time: it may work later.
  return "smtp_unavailable";
}

export function createSmtpEgress(deps: SmtpEgressDeps = {}) {
  const resolve = deps.resolve ?? systemResolve;
  const isBlocked = deps.isBlocked ?? isBlockedAddress;
  const env = deps.env ?? process.env;
  const sendMail = deps.send ?? ((config, message) => new SmtpClient(config).send(message));
  const timeoutMs = deps.timeoutMs ?? SMTP_TIMEOUT_MS;
  const log = deps.log ?? appLog;

  /** Steps 1 to 3: the addresses (and port) to connect to. */
  async function check(
    q: Queryable,
    req: MailRequest,
  ): Promise<{ addresses: ResolvedAddress[]; port: number; ca?: string | Buffer }> {
    const host = req.server.host.toLowerCase();
    const insecure = req.server.mode === "none";
    if (insecure && (env.NODE_ENV === "production" || !LOOPBACK_NAMES.has(host)))
      throw new SmtpEgressError("insecure_refused", host);
    if (await isPausedAll(q)) throw new SmtpEgressError("paused_all", host);
    // Only with TLS: the e2e's server proves the name with its certificate.
    const routed = insecure ? undefined : deps.route?.(host, req.server.port);
    if (routed) return { addresses: routed.addresses, port: routed.port, ca: routed.ca };
    let addresses: ResolvedAddress[];
    if (isIP(host)) addresses = [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
    else {
      try {
        addresses = await resolve(host);
      } catch {
        throw new SmtpEgressError("dns_failed", host);
      }
    }
    if (!addresses.length) throw new SmtpEgressError("dns_failed", host);
    if (insecure) {
      if (!addresses.every((a) => isLoopbackAddress(a.address))) throw new SmtpEgressError("insecure_refused", host);
    } else if (addresses.some((a) => isBlocked(a.address))) {
      throw new SmtpEgressError("private_address", host);
    }
    return { addresses, port: req.server.port };
  }

  async function record(q: Queryable, req: MailRequest, host: string, durationMs: number, errorCode: string | null) {
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
          null,
          durationMs,
          errorCode,
        ],
      );
    } catch (err) {
      log.warn("egress.record_failed", { connector: req.call.connector, error: (err as Error).message });
    }
  }

  /** Send one message; an SmtpEgressError when it was refused or failed. */
  async function send(q: Queryable, req: MailRequest): Promise<SmtpResult> {
    const started = performance.now();
    const host = req.server.host.toLowerCase();
    const fields = { connector: req.call.connector, protocol: "smtp", host, port: req.server.port };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SmtpEgressError("smtp_unavailable", host)), timeoutMs);
    });
    timedOut.catch(() => undefined);
    try {
      const { addresses: pinned, port, ca } = await Promise.race([check(q, req), timedOut]);
      const insecure = req.server.mode === "none";
      const config: SmtpConfig = {
        host,
        port,
        security: req.server.mode,
        // No AUTH without TLS: the client would refuse it anyway.
        ...(insecure ? {} : { user: req.server.username, password: req.server.password }),
        heloName: addressOf(req.message.from).split("@")[1] || "localhost",
        timeoutMs,
        lookup: pinnedLookup(pinned),
        ...(ca ? { ca } : {}),
      };
      let result: SmtpResult;
      try {
        result = await Promise.race([sendMail(config, req.message), timedOut]);
      } catch (err) {
        if (err instanceof SmtpEgressError) throw err;
        throw new SmtpEgressError(err instanceof SmtpError ? codeOfSmtpReason(err.reason) : "smtp_unavailable", host);
      }
      const durationMs = Math.round(performance.now() - started);
      log.info("egress.call", { ...fields, durationMs });
      await record(q, req, host, durationMs, null);
      return result;
    } catch (err) {
      const e = err instanceof SmtpEgressError ? err : new SmtpEgressError("smtp_unavailable", host);
      const durationMs = Math.round(performance.now() - started);
      log.warn("egress.call", { ...fields, durationMs, errorCode: e.code });
      await record(q, req, host, durationMs, e.code);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  return { send };
}

export type SmtpEgress = ReturnType<typeof createSmtpEgress>;
