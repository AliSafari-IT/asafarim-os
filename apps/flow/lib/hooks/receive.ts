/**
 * POST /hooks/<id>: Flow's only unauthenticated path. Everything is checked before the body is parsed,
 * in this order, and the first check that fails answers:
 *
 *   over 600 calls a minute (all)      429  with Retry-After, before any lookup (lib/hooks/limiter.ts)
 *   unknown hook                       404  {error:"rejected"}, after the same body read and HMAC a bad
 *                                           signature costs (the body and the work are the same)
 *   Content-Length over 256 KiB        413  before a byte is read
 *   Content-Type not application/json  415
 *   over 60 calls a minute (the hook)  429  with Retry-After (lib/hooks/limiter.ts)
 *   body over 256 KiB                  413  read with a byte cap, cancelled at the cap
 *   signature missing or wrong         401  {error:"rejected"} (lib/hooks/signature.ts); generic hooks: a
 *                                           timestamp more than 5 minutes off is wrong too
 *   then the body is parsed: not JSON  415
 *
 * A GitHub `ping` answers 200. Otherwise the run starts (lib/engine startRun) with the trigger event id
 * `hook:<id>:<delivery>`: X-GitHub-Delivery for GitHub, X-Flow-Delivery, or else the signature, so a
 * redelivery is `duplicate` and answers 200 {duplicate:true}. A run: 202 {runId}. A paused workflow or
 * Settings `paused_all`: 202 {started:false}; a GitHub event the trigger doesn't take: 202
 * {started:false, reason:"filtered"}. A body that doesn't fit a generic trigger's input: 422. No
 * published version, or one whose trigger names another hook: 409.
 *
 * Each call logs ONE line: the hook id (when it is shaped like one), the status and the duration.
 * Never the body, a header or the secret; an answer never carries them either.
 */
import { CredentialError } from "../credentials/cipher";
import type { StartResult, StartRunOptions } from "../engine/engine";
import { HOOK_ID, type TriggerV2 } from "../workflow/definition-v2";
import { BODY_MAX_BYTES, readCapped } from "./body";
import { githubAccepts } from "./github";
import type { RateLimiter } from "./limiter";
import { verifyGeneric, verifyGithub, verifyNothing } from "./signature";
import type { ReceivingHook } from "./store";

export interface ReceiveDeps {
  /** The hook with its secret; undefined when there is none. May throw a CredentialError. */
  findHook(id: string): Promise<ReceivingHook | undefined>;
  /** Set the hook's last_called_at and start the run, in one transaction. */
  start(hook: ReceivingHook, opts: StartRunOptions): Promise<StartResult>;
  /** Set the hook's last_called_at (a ping). */
  touch(hook: ReceivingHook): Promise<void>;
  /** Per hook (RATE_LIMIT). */
  limiter: RateLimiter;
  /** Every call, under one key (GLOBAL_RATE_LIMIT). */
  globalLimiter: RateLimiter;
  now(): Date;
  log: { info(msg: string, fields?: Record<string, unknown>): void };
}

/** The one body of a 404 and a 401: neither says which it was beyond the status. */
const REJECTED = { error: "rejected" };
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
      hook: shaped ? id : "invalid",
      status,
      durationMs: Math.round(performance.now() - began),
    });
    return Response.json(body, { status, headers });
  };

  try {
    // First, before the lookup: bounds the database and CPU work a flood of unknown ids can cause. A
    // per-address limit belongs to the edge proxy, which sees the client's address.
    if (!deps.globalLimiter.take("all", deps.now().getTime()))
      return answer(429, { error: "rate_limited" }, { "Retry-After": "60" });
    let hook: ReceivingHook | undefined;
    try {
      hook = shaped ? await deps.findHook(id) : undefined;
    } catch (err) {
      if (err instanceof CredentialError) return answer(503, { error: "unavailable" });
      throw err;
    }
    if (!hook) {
      verifyNothing((await readCapped(request.body)) ?? new Uint8Array());
      return answer(404, REJECTED);
    }

    const length = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > BODY_MAX_BYTES) {
      await request.body?.cancel().catch(() => undefined);
      return answer(413, { error: "too_large" });
    }
    if (!isJson(request.headers.get("content-type"))) return answer(415, { error: "not_json" });
    if (!deps.limiter.take(hook.id, deps.now().getTime()))
      return answer(429, { error: "rate_limited" }, { "Retry-After": "60" });
    const raw = await readCapped(request.body);
    if (!raw) return answer(413, { error: "too_large" });

    const github = hook.kind === "github";
    const verdict = github
      ? verifyGithub(hook.secret, request.headers.get("x-hub-signature-256"), raw)
      : verifyGeneric(hook.secret, request.headers.get("x-flow-signature"), raw, deps.now());
    if (!verdict.ok) return answer(401, REJECTED);

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
    const delivery = request.headers.get(github ? "x-github-delivery" : "x-flow-delivery") ?? verdict.signature;
    if (!DELIVERY.test(delivery)) return answer(400, { error: "invalid_delivery" });

    const accepts = (trigger: TriggerV2) => {
      if ((trigger.type !== "webhook" && trigger.type !== "github") || trigger.hook !== hook.id) return "wrong_trigger";
      if (trigger.type === "github")
        return githubAccepts(trigger, event!, isRecord(data) ? data : {}) ? undefined : "filtered";
      return undefined;
    };
    const r = await deps.start(hook, {
      workflowKey: hook.workflowKey,
      trigger: github ? "github" : "webhook",
      data,
      triggerEventId: `hook:${hook.id}:${delivery}`,
      accepts,
    });
    if (r.ok) return answer(202, { runId: r.runId });
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
      hook: shaped ? id : "invalid",
      error: err instanceof Error ? err.name : "unknown",
    });
    return answer(500, { error: "internal" });
  }
}
