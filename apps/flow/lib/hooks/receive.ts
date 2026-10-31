/**
 * POST /hooks/<id>: Flow's only unauthenticated path. Everything is checked before the body is parsed,
 * in this order, and the first check that fails answers:
 *
 *   over 120 calls a minute (the source) 429 with Retry-After, before any lookup: the source is the
 *                                           address the edge proxy appended to X-Forwarded-For
 *   over 600 calls a minute (all)      429  with Retry-After, before any lookup (lib/hooks/limiter.ts)
 *   Content-Length over 256 KiB        413  before a byte is read
 *   Content-Type not application/json  415
 *   body over 256 KiB                  413  read with a byte cap, cancelled at the cap
 *   hook unknown, id not shaped like one, signature missing or wrong
 *                                      401  {error:"rejected"}, the one answer for all of them (lib/hooks/
 *                                           signature.ts): an unknown hook is checked against a secret
 *                                           nobody has, so it costs the same read and HMAC; generic hooks:
 *                                           a timestamp more than 5 minutes off is wrong too
 *   over 60 calls a minute (the hook)  429  with Retry-After; counted only for a call that is signed, so
 *                                           forged calls can't use up the allowance of the real sender
 *   then the body is parsed: not JSON  415
 *
 * Which hook ids exist is not told: the lookup's time is the one difference left, and the per-source
 * limit bounds how often it can be measured.
 *
 * A GitHub `ping` answers 200. Otherwise a delivery id is required (X-GitHub-Delivery for GitHub,
 * X-Flow-Delivery otherwise: 400 `missing_delivery` without one) and the run starts (lib/engine
 * startRun), a GitHub one with the payload and its labels' names (lib/hooks/github.ts githubTriggerData),
 * with the trigger event id `hook:<id>:<delivery>`, so a redelivery is `duplicate` and answers 200
 * {duplicate:true}. GitHub's delivery id is not signed and its signature has no clock, so a GitHub
 * signature is remembered too (lib/hooks/limiter.ts createSeenStore): the same signed call under another
 * delivery id is a `duplicate` as well. A generic one is not (two deliveries may share body and second).
 * A run: 202 {runId}. A paused workflow or Settings `paused_all`: 202 {started:false}; a GitHub event the
 * trigger doesn't take: 202 {started:false, reason:"filtered"}. A body that doesn't fit a generic
 * trigger's input: 422. No published version, or one whose trigger names another hook: 409.
 *
 * Each call logs ONE line: a short hash of the hook id (the id is the URL's path, so it stays out of the
 * logs; "invalid" when it isn't shaped like one), the status and the duration. Never the body, a header or
 * the secret; an answer never carries them either.
 */
import { createHash, randomBytes } from "node:crypto";
import { CredentialError } from "../credentials/cipher";
import type { StartResult, StartRunOptions } from "../engine/engine";
import { HOOK_ID, type TriggerV2 } from "../workflow/definition-v2";
import { BODY_MAX_BYTES, readCapped } from "./body";
import { githubAccepts, githubTriggerData } from "./github";
import type { RateLimiter, SeenStore } from "./limiter";
import { verifyGeneric, verifyGithub } from "./signature";
import type { ReceivingHook } from "./store";

export interface ReceiveDeps {
  /** The hook with its secret; undefined when there is none. May throw a CredentialError. */
  findHook(id: string): Promise<ReceivingHook | undefined>;
  /** Set the hook's last_called_at and start the run, in one transaction. */
  start(hook: ReceivingHook, opts: StartRunOptions): Promise<StartResult>;
  /** Set the hook's last_called_at (a ping). */
  touch(hook: ReceivingHook): Promise<void>;
  /** Per hook (RATE_LIMIT), counted for signed calls only. */
  limiter: RateLimiter;
  /** Per source address (SOURCE_RATE_LIMIT), first of all. */
  sourceLimiter: RateLimiter;
  /** Every call, under one key (GLOBAL_RATE_LIMIT). */
  globalLimiter: RateLimiter;
  /** The signatures seen: a signed call repeated under another delivery id is a replay. */
  replays: SeenStore;
  now(): Date;
  log: { info(msg: string, fields?: Record<string, unknown>): void };
}

/** The one body of a 404 and a 401: neither says which it was beyond the status. */
const REJECTED = { error: "rejected" };
/** The secret an unknown hook is checked against: random per process, so no signature ever matches. */
const DECOY_SECRET = randomBytes(32).toString("hex");

/** A short, stable stand-in for a hook id in the logs. */
export const hookRef = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 12);

/**
 * The caller's address: the RIGHTMOST X-Forwarded-For entry, the one the edge proxy appended. The ones
 * to its left come from the client and can be forged, so they never key a limit. A call that reaches
 * Flow without a proxy can name any address; it then only gets around the per-source limit, and the
 * others still hold.
 */
export function sourceOf(request: Request): string {
  const entries = (request.headers.get("x-forwarded-for") ?? "").split(",");
  const last = entries[entries.length - 1]?.trim();
  return last && /^[0-9a-fA-F:.]{1,45}$/.test(last) ? last : "unknown";
}

/** A delivery id as it may go into a trigger event id. */
const DELIVERY = /^[A-Za-z0-9._:-]{1,128}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isJson = (contentType: string | null) =>
  contentType !== null && /^application\/json\s*(?:;|$)/i.test(contentType.trim());

export async function receiveHook(request: Request, id: string, deps: ReceiveDeps): Promise<Response> {
  const began = performance.now();
  const shaped = HOOK_ID.test(id);
  const answer = (status: number, body: object, headers: Record<string, string> = {}) => {
    deps.log.info("flow.hook.called", {
      hook: shaped ? hookRef(id) : "invalid",
      status,
      durationMs: Math.round(performance.now() - began),
    });
    return Response.json(body, { status, headers });
  };

  try {
    // First, before the lookup: the source's own allowance, then the shared one. They bound the database
    // and CPU work a flood of unknown ids or forged signatures can cause, and one source can't use up
    // what the others share.
    const at = deps.now().getTime();
    if (!deps.sourceLimiter.take(sourceOf(request), at) || !deps.globalLimiter.take("all", at))
      return answer(429, { error: "rate_limited" }, { "Retry-After": "60" });
    let found: ReceivingHook | undefined;
    try {
      found = shaped ? await deps.findHook(id) : undefined;
    } catch (err) {
      if (err instanceof CredentialError) return answer(503, { error: "unavailable" });
      throw err;
    }
    // A hook that doesn't exist goes the same way as one that does, against a secret nobody has.
    const hook: ReceivingHook = found ?? { id: "", workflowKey: "", kind: "generic", secret: DECOY_SECRET };

    const length = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > BODY_MAX_BYTES) {
      await request.body?.cancel().catch(() => undefined);
      return answer(413, { error: "too_large" });
    }
    if (!isJson(request.headers.get("content-type"))) return answer(415, { error: "not_json" });
    const raw = await readCapped(request.body);
    if (!raw) return answer(413, { error: "too_large" });

    const github = hook.kind === "github";
    const verdict = github
      ? verifyGithub(hook.secret, request.headers.get("x-hub-signature-256"), raw)
      : verifyGeneric(hook.secret, request.headers.get("x-flow-signature"), raw, deps.now());
    if (!found || !verdict.ok) return answer(401, REJECTED);
    // Signed: now it counts against the hook's own allowance.
    if (!deps.limiter.take(hook.id, deps.now().getTime()))
      return answer(429, { error: "rate_limited" }, { "Retry-After": "60" });

    let data: unknown;
    try {
      data = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      return answer(415, { error: "not_json" });
    }

    const event = github ? request.headers.get("x-github-event") : null;
    if (github && event === "ping") {
      await deps.touch(hook);
      return answer(200, { ok: true });
    }
    if (github && (event === null || !/^[a-z_]{1,64}$/.test(event))) return answer(400, { error: "no_event" });
    const delivery = request.headers.get(github ? "x-github-delivery" : "x-flow-delivery");
    if (delivery === null) return answer(400, { error: "missing_delivery" });
    if (!DELIVERY.test(delivery)) return answer(400, { error: "invalid_delivery" });
    // GitHub's delivery id isn't signed and its signature has no clock: the same signed call under
    // another delivery id is still the same call. (Not for a generic hook: its signature is its body and
    // the second, so two different deliveries with the same body in the same second would be taken for
    // one and the second lost. Its replay window is the ±5 minutes of the timestamp.)
    const replayKey = `${hook.id}:${verdict.signature}`;
    if (github && deps.replays.has(replayKey, deps.now().getTime())) return answer(200, { duplicate: true });

    const accepts = (trigger: TriggerV2) => {
      if ((trigger.type !== "webhook" && trigger.type !== "github") || trigger.hook !== hook.id) return "wrong_trigger";
      if (trigger.type === "github")
        return githubAccepts(trigger, event!, isRecord(data) ? data : {}) ? undefined : "filtered";
      return undefined;
    };
    // Claimed before the run starts, so an overlapping copy sees it; given back if no run starts.
    if (github) deps.replays.add(replayKey, deps.now().getTime());
    let r: StartResult;
    try {
      r = await deps.start(hook, {
        workflowKey: hook.workflowKey,
        trigger: github ? "github" : "webhook",
        data: github && isRecord(data) ? githubTriggerData(data) : data,
        triggerEventId: `hook:${hook.id}:${delivery}`,
        accepts,
      });
    } catch (err) {
      deps.replays.delete(replayKey);
      throw err;
    }
    if (r.ok) return answer(202, { runId: r.runId });
    // A delivery that started nothing (paused, filtered, invalid, duplicate) keeps no claim: sent
    // again once it can run, it runs.
    deps.replays.delete(replayKey);
    switch (r.error) {
      case "duplicate":
        return answer(200, { duplicate: true });
      case "not_active":
        return answer(202, { started: false, reason: "paused" });
      case "paused_all":
        return answer(202, { started: false, reason: "paused_all" });
      case "filtered":
        return answer(202, { started: false, reason: "filtered" });
      case "invalid_input":
        return answer(422, { error: "invalid_input", problems: (r.problems ?? []).map((p) => p.message) });
      default:
        // No published version, or one whose trigger doesn't name this hook.
        return answer(409, { error: r.error });
    }
  } catch (err) {
    deps.log.info("flow.hook.failed", {
      hook: shaped ? hookRef(id) : "invalid",
      error: err instanceof Error ? err.name : "unknown",
    });
    return answer(500, { error: "internal" });
  }
}
