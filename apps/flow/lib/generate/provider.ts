/**
 * The AI that drafts a workflow from an issue (#283), behind one small interface so the rest of Flow
 * (and its tests) don't know the provider. The one provider is Anthropic's Messages API (Claude), called
 * through lib/egress like every call Flow makes (HTTPS to api.anthropic.com only, pinned DNS, no
 * redirect, recorded in connector_calls): plain HTTP, not the SDK, because the SDK would open its own
 * connections around the egress layer.
 *
 * The request carries no tools: the answer is constrained to a JSON schema (structured outputs,
 * `output_config.format`). The key is FLOW_AI_API_KEY (the encrypted env); it goes in a header only and
 * nothing here logs a prompt or an answer.
 */
import { EgressError, type EgressRequest, type EgressResponse } from "../egress/egress";
import type { Queryable } from "../settings";

export const ANTHROPIC_HOST = "api.anthropic.com";
export const ANTHROPIC_VERSION = "2026-10-21";
/** Server-side fallback when a model declines (refusal): routed by the API, no model list to keep. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT = "medium";
export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];
export const AI_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_TOKENS = 16_000;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateRequest {
  system: string;
  user: string;
  /** The JSON Schema the answer must follow. */
  schema: Record<string, unknown>;
}

export interface GenerateAnswer {
  /** The parsed JSON answer, unvalidated: lib/generate/draft.ts validates it. */
  answer: unknown;
  usage: Usage;
  /** The model that answered (a fallback model when the first declined). */
  model: string;
}

export type GeneratorErrorCode =
  /** No answer in time. */
  | "timeout"
  /** The API failed, refused the request, or the call couldn't be made. */
  | "unavailable"
  /** The model declined (stop_reason refusal) on every model the API tried. */
  | "refused"
  /** An answer that isn't the JSON asked for (cut off, empty, not JSON). */
  | "invalid_answer"
  /** Flow is paused (Settings `paused_all`). */
  | "paused";

export class GeneratorError extends Error {
  constructor(
    readonly code: GeneratorErrorCode,
    /** Tokens the call used before it failed, when the API said. */
    readonly usage?: Usage,
    /** The HTTP status or egress code, for the log. */
    readonly detail?: string,
  ) {
    super(`AI ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "GeneratorError";
  }
}

export interface DraftGenerator {
  readonly provider: "anthropic";
  readonly model: string;
  generate(req: GenerateRequest): Promise<GenerateAnswer>;
}

export interface GeneratorEgress {
  request(q: Queryable, req: EgressRequest): Promise<EgressResponse>;
}

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  effort?: Effort;
  egress: GeneratorEgress;
  db: Queryable;
  timeoutMs?: number;
}

/** The parts of a Messages API answer this reads. */
interface MessagesAnswer {
  model?: unknown;
  stop_reason?: unknown;
  content?: { type?: unknown; text?: unknown }[];
  usage?: Record<string, unknown>;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

function usageOf(data: MessagesAnswer | undefined): Usage {
  const u = data?.usage ?? {};
  return {
    inputTokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
    outputTokens: num(u.output_tokens),
  };
}

export function createAnthropicGenerator(opts: AnthropicOptions): DraftGenerator {
  const model = opts.model ?? DEFAULT_MODEL;
  const effort = opts.effort ?? DEFAULT_EFFORT;
  return {
    provider: "anthropic",
    model,
    async generate({ system, user, schema }) {
      let res: EgressResponse;
      try {
        res = await opts.egress.request(opts.db, {
          method: "POST",
          url: `https://${ANTHROPIC_HOST}/v1/messages`,
          headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "anthropic-beta": FALLBACK_BETA,
          },
          body: JSON.stringify({
            model,
            max_tokens: MAX_OUTPUT_TOKENS,
            system,
            messages: [{ role: "user", content: user }],
            output_config: { effort, format: { type: "json_schema", schema } },
            fallbacks: "default",
          }),
          allow: [{ host: ANTHROPIC_HOST }],
          call: { connector: "generate.anthropic" },
          timeoutMs: opts.timeoutMs ?? AI_TIMEOUT_MS,
        });
      } catch (err) {
        if (err instanceof EgressError) {
          if (err.code === "timeout") throw new GeneratorError("timeout", undefined, err.code);
          if (err.code === "paused_all") throw new GeneratorError("paused", undefined, err.code);
          throw new GeneratorError("unavailable", undefined, err.code);
        }
        throw new GeneratorError("unavailable", undefined, "request_failed");
      }
      let data: MessagesAnswer | undefined;
      try {
        data = JSON.parse(res.body.toString("utf8")) as MessagesAnswer;
      } catch {
        data = undefined;
      }
      if (res.status < 200 || res.status >= 300) {
        // The API's error type (invalid_request_error, overloaded_error, …) for the log; never its message.
        const type = (data as { error?: { type?: unknown } } | undefined)?.error?.type;
        const kind = typeof type === "string" && /^[a-z_]{1,64}$/.test(type) ? `_${type}` : "";
        throw new GeneratorError("unavailable", undefined, `http_${res.status}${kind}`);
      }
      const usage = usageOf(data);
      if (!data) throw new GeneratorError("invalid_answer", usage, "not_json");
      if (data.stop_reason === "refusal") throw new GeneratorError("refused", usage);
      if (data.stop_reason === "max_tokens") throw new GeneratorError("invalid_answer", usage, "max_tokens");
      const text = (data.content ?? []).find((c) => c?.type === "text" && typeof c.text === "string")?.text;
      if (typeof text !== "string") throw new GeneratorError("invalid_answer", usage, "no_text");
      let answer: unknown;
      try {
        answer = JSON.parse(text);
      } catch {
        throw new GeneratorError("invalid_answer", usage, "answer_not_json");
      }
      return { answer, usage, model: typeof data.model === "string" ? data.model : model };
    },
  };
}

/** The AI settings from the environment: none without FLOW_AI_API_KEY (the feature is then not configured). */
export function aiConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): { apiKey: string; model: string; effort: Effort } | null {
  const apiKey = env.FLOW_AI_API_KEY?.trim();
  if (!apiKey) return null;
  const model = env.FLOW_AI_MODEL?.trim() || DEFAULT_MODEL;
  const effort = (EFFORTS as readonly string[]).includes(env.FLOW_AI_EFFORT ?? "")
    ? (env.FLOW_AI_EFFORT as Effort)
    : DEFAULT_EFFORT;
  return { apiKey, model, effort };
}
